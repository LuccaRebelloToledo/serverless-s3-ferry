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
  ONLY_FOR_STAGE_KEY,
  type ParamMatcher,
  type Plugin,
  S3_CONTENT_MD5_METADATA_KEY,
  type S3Object,
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

function computeFileMD5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
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
    const head = await s3Client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: s3Key }),
    );
    const storedMD5 = head.Metadata?.[S3_CONTENT_MD5_METADATA_KEY];
    if (storedMD5 && localMD5 === storedMD5) {
      return true;
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
        const localMD5 = await computeFileMD5(entry.localPath);

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

        const stat = await fs.promises.stat(entry.localPath);

        // Stream large files to avoid holding full buffer in memory during upload
        const body: Buffer | fs.ReadStream =
          stat.size > multipartThreshold
            ? fs.createReadStream(entry.localPath)
            : await fs.promises.readFile(entry.localPath);

        const putParams: PutObjectCommandInput = {
          Bucket: bucket,
          Key: entry.s3Key,
          Body: body,
          ACL: acl,
          ContentType: contentType,
          Metadata: {
            [S3_CONTENT_MD5_METADATA_KEY]: localMD5,
          },
          ...entry.s3Params,
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
