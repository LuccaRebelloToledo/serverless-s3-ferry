import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  HeadObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import {
  createProgressTracker,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MULTIPART_THRESHOLD,
  DEFAULT_PART_SIZE,
  DEFAULT_QUEUE_SIZE,
  type ErrorLogger,
  getLocalFiles,
  MAX_OBJECT_SIZE,
  MAX_PARTS_PER_UPLOAD,
  ONLY_FOR_STAGE_KEY,
  type ParamMatcher,
  type Plugin,
  S3_CONTENT_MD5_METADATA_KEY,
  type S3Object,
  S3OperationError,
  type S3Params,
  toS3Path,
  type UploadDirOptions,
} from '@shared';
import mime from 'mime';
import { minimatch } from 'minimatch';
import pLimit from 'p-limit';
import { deleteObjectsByKeys } from './delete';
import { listAllObjects } from './list';

interface UploadDirectoryOptions extends UploadDirOptions {
  s3Client: S3Client;
  progress: Plugin.Progress;
  servicePath: string;
  stage?: string;
  log?: ErrorLogger;
}

interface FileProcessEntry {
  localPath: string;
  s3Key: string;
  s3Params: S3Params;
}

function computeBufferMD5(buffer: Buffer): string {
  return `"${crypto.createHash('md5').update(buffer).digest('hex')}"`;
}

// Streams the file for MD5 without loading it into memory.
// Uses autoClose: false to keep the shared file handle open for subsequent reads.
function computeStreamMD5(fh: fs.promises.FileHandle): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fh.createReadStream({ start: 0, autoClose: false });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(`"${hash.digest('hex')}"`));
    stream.on('error', reject);
  });
}

interface IsFileUnchangedOptions {
  s3Client: S3Client;
  bucket: string;
  s3Key: string;
  localMD5: string;
  remote?: S3Object;
}

async function isFileUnchanged(
  options: IsFileUnchangedOptions,
): Promise<boolean> {
  const { s3Client, bucket, s3Key, localMD5, remote } = options;

  if (!remote) {
    return false;
  }

  // Fast path: ETag matches (works for single-part uploads)
  if (remote.ETag && localMD5 === remote.ETag) {
    return true;
  }

  // Slow path: multipart ETags don't match simple MD5
  // Check content-md5 metadata stored during previous multipart upload
  if (remote.ETag?.includes('-')) {
    try {
      const head = await s3Client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: s3Key }),
      );
      const storedMD5 = head.Metadata?.[S3_CONTENT_MD5_METADATA_KEY];
      if (storedMD5 && localMD5 === storedMD5) {
        return true;
      }
    } catch {
      // HeadObject failed (permissions, network) — fall back to re-uploading
      return false;
    }
  }

  return false;
}

interface ResolveS3ParamsOptions {
  localFile: string;
  localDir: string;
  params?: ParamMatcher[];
  stage?: string;
}

function resolveS3Params(options: ResolveS3ParamsOptions): S3Params | null {
  const { localFile, localDir, params, stage } = options;
  if (!params || params.length === 0) {
    return {};
  }

  const s3Params: S3Params = {};
  let onlyForStage: string | undefined;

  for (const param of params) {
    if (minimatch(localFile, `${path.resolve(localDir)}/${param.glob}`)) {
      Object.assign(s3Params, param.params);
      if (s3Params[ONLY_FOR_STAGE_KEY]) {
        onlyForStage = s3Params[ONLY_FOR_STAGE_KEY];
      }
    }
  }

  delete s3Params[ONLY_FOR_STAGE_KEY];

  if (onlyForStage && onlyForStage !== stage) {
    return null; // skip this file
  }

  return s3Params;
}

export async function uploadDirectory(
  options: UploadDirectoryOptions,
): Promise<void> {
  const {
    s3Client,
    localDir,
    bucket,
    prefix,
    acl,
    deleteRemoved,
    defaultContentType,
    params,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    multipartThreshold = DEFAULT_MULTIPART_THRESHOLD,
    partSize = DEFAULT_PART_SIZE,
    queueSize = DEFAULT_QUEUE_SIZE,
    progress,
    stage,
    log,
  } = options;

  const localFiles = getLocalFiles({ dir: localDir, log });
  const remoteObjects = await listAllObjects({ s3Client, bucket, prefix });

  // Build a map of remote objects by key for quick lookup
  const remoteByKey = new Map<string, S3Object>();
  for (const obj of remoteObjects) {
    remoteByKey.set(obj.Key, obj);
  }

  // Build list of candidate files and track local keys (without reading file content)
  const filesToProcess: FileProcessEntry[] = [];
  const localKeys = new Set<string>();

  for (const localFile of localFiles) {
    const relativePath = path.relative(localDir, localFile);
    const s3Key = prefix
      ? `${prefix}${toS3Path(relativePath)}`
      : toS3Path(relativePath);

    localKeys.add(s3Key);

    // Resolve per-file S3 params (may return null to skip)
    const s3Params = resolveS3Params({ localFile, localDir, params, stage });
    if (s3Params === null) {
      continue;
    }

    filesToProcess.push({ localPath: localFile, s3Key, s3Params });
  }

  // Determine files to delete (exist remotely but not locally)
  const keysToDelete: string[] = [];
  if (deleteRemoved) {
    for (const remoteKey of remoteByKey.keys()) {
      if (!localKeys.has(remoteKey)) {
        keysToDelete.push(remoteKey);
      }
    }
  }

  const totalOperations =
    filesToProcess.length + (keysToDelete.length > 0 ? 1 : 0);
  let completedOperations = 0;

  const tracker = createProgressTracker({
    progressEntry: progress,
    buildMessage: (percent) =>
      `${localDir}: sync with bucket ${bucket} (${percent}%)`,
  });

  // Upload files with multipart support via @aws-sdk/lib-storage
  const limit = pLimit(maxConcurrency);
  await Promise.all(
    filesToProcess.map((entry) =>
      limit(async () => {
        // Open file descriptor once to avoid TOCTOU race conditions
        // All operations (stat, MD5, upload body) use the same fd
        const fh = await fs.promises.open(entry.localPath, 'r');
        try {
          const stat = await fh.stat();

          if (stat.size > MAX_OBJECT_SIZE) {
            throw new S3OperationError(
              `File ${entry.localPath} (${stat.size} bytes) exceeds the maximum S3 object size of ${MAX_OBJECT_SIZE} bytes (~48.8 TiB)`,
              bucket,
            );
          }

          const requiredParts = Math.ceil(stat.size / partSize);
          if (requiredParts > MAX_PARTS_PER_UPLOAD) {
            throw new S3OperationError(
              `File ${entry.localPath} (${stat.size} bytes) would require ${requiredParts} parts with partSize ${partSize}, exceeding the S3 limit of ${MAX_PARTS_PER_UPLOAD} parts. Increase partSize to at least ${Math.ceil(stat.size / MAX_PARTS_PER_UPLOAD)} bytes`,
              bucket,
            );
          }

          const isLargeFile = stat.size > multipartThreshold;

          // MD5 is always needed: either for change detection (ETag comparison)
          // or for the x-amz-meta-content-md5 metadata on upload
          // Small files: read buffer once, compute MD5 from it, reuse buffer for upload
          // Large files: stream MD5 computation, then stream upload body separately
          let localMD5: string;
          let body: Buffer | fs.ReadStream;

          if (isLargeFile) {
            localMD5 = await computeStreamMD5(fh);
            // autoClose: false keeps the shared fd open — closed in the finally block
            body = fh.createReadStream({ start: 0, autoClose: false });
          } else {
            const buffer = await fh.readFile();
            localMD5 = computeBufferMD5(buffer);
            body = buffer;
          }

          // Check if file has changed (supports both single-part and multipart ETags)
          const remote = remoteByKey.get(entry.s3Key);
          const unchanged = await isFileUnchanged({
            s3Client,
            bucket,
            s3Key: entry.s3Key,
            localMD5,
            remote,
          });
          if (unchanged) {
            completedOperations++;
            tracker.update(completedOperations, totalOperations);
            return;
          }

          const contentType =
            mime.getType(entry.localPath) ??
            defaultContentType ??
            DEFAULT_CONTENT_TYPE;

          const putParams: PutObjectCommandInput = {
            ...entry.s3Params,
            Bucket: bucket,
            Key: entry.s3Key,
            Body: body,
            ACL: acl,
            ContentType: contentType,
            Metadata: {
              [S3_CONTENT_MD5_METADATA_KEY]: localMD5,
            },
            ...(isLargeFile && { ContentLength: stat.size }),
          };

          const upload = new Upload({
            client: s3Client,
            params: putParams,
            queueSize,
            partSize,
            leavePartsOnError: false,
          });

          await upload.done();

          completedOperations++;
          tracker.update(completedOperations, totalOperations);
        } finally {
          await fh.close();
        }
      }),
    ),
  );

  // Delete removed files
  if (keysToDelete.length > 0) {
    await deleteObjectsByKeys({ s3Client, bucket, keys: keysToDelete });
    completedOperations++;
    tracker.update(completedOperations, totalOperations);
  }
}
