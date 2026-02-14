import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  createProgressTracker,
  type ErrorLogger,
  type FileUploadEntry,
  getLocalFiles,
  type ParamMatcher,
  type Plugin,
  type S3Object,
  type S3Params,
  toS3Path,
  type UploadDirOptions,
} from '@shared';
import mime from 'mime';
import { minimatch } from 'minimatch';
import pLimit from 'p-limit';

export interface UploadDirectoryOptions extends UploadDirOptions {
  s3Client: S3Client;
  progress: Plugin.Progress;
  servicePath: string;
  env?: string;
  log?: ErrorLogger;
}

async function listAllObjects(
  s3Client: S3Client,
  bucket: string,
  prefix: string,
): Promise<S3Object[]> {
  const objects: S3Object[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key) {
          objects.push({
            Key: obj.Key,
            ETag: obj.ETag,
            Size: obj.Size,
          });
        }
      }
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return objects;
}

function computeMD5(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return `"${crypto.createHash('md5').update(content).digest('hex')}"`;
}

function resolveS3Params(
  localFile: string,
  localDir: string,
  params: ParamMatcher[] | undefined,
  env: string | undefined,
): S3Params | null {
  if (!params || params.length === 0) {
    return {};
  }

  const s3Params: S3Params = {};
  let onlyForEnv: string | undefined;

  for (const param of params) {
    if (minimatch(localFile, `${path.resolve(localDir)}/${param.glob}`)) {
      Object.assign(s3Params, param.params);
      onlyForEnv = s3Params.OnlyForEnv || onlyForEnv;
    }
  }

  delete s3Params.OnlyForEnv;

  if (onlyForEnv && onlyForEnv !== env) {
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
    maxConcurrency = 5,
    progress,
    env,
    log,
  } = options;

  const localFiles = getLocalFiles(localDir, log);
  const remoteObjects = await listAllObjects(s3Client, bucket, prefix);

  // Build a map of remote objects by key for quick lookup
  const remoteByKey = new Map<string, S3Object>();
  for (const obj of remoteObjects) {
    remoteByKey.set(obj.Key, obj);
  }

  // Determine which files need uploading
  const filesToUpload: FileUploadEntry[] = [];
  const localKeys = new Set<string>();

  for (const localFile of localFiles) {
    const relativePath = path.relative(localDir, localFile);
    const s3Key = prefix
      ? `${prefix}${toS3Path(relativePath)}`
      : toS3Path(relativePath);

    localKeys.add(s3Key);

    // Resolve per-file S3 params (may return null to skip)
    const s3Params = resolveS3Params(localFile, localDir, params, env);
    if (s3Params === null) {
      continue;
    }

    // Check if file has changed by comparing MD5 with ETag
    const remote = remoteByKey.get(s3Key);
    if (remote?.ETag) {
      const localMD5 = computeMD5(localFile);
      if (localMD5 === remote.ETag) {
        continue; // file unchanged
      }
    }

    filesToUpload.push({ localPath: localFile, s3Key, s3Params });
  }

  // Determine files to delete (exist remotely but not locally)
  const keysToDelete: string[] = [];
  if (deleteRemoved) {
    for (const remoteKey of remoteByKey.keys()) {
      // Only consider keys under our prefix
      if (!localKeys.has(remoteKey)) {
        keysToDelete.push(remoteKey);
      }
    }
  }

  const totalOperations =
    filesToUpload.length + (keysToDelete.length > 0 ? 1 : 0);
  let completedOperations = 0;

  const tracker = createProgressTracker(
    progress,
    (percent) => `${localDir}: sync with bucket ${bucket} (${percent}%)`,
  );

  // Upload new/changed files
  const limit = pLimit(maxConcurrency);
  await Promise.all(
    filesToUpload.map((file) =>
      limit(async () => {
        const contentType =
          mime.getType(file.localPath) ??
          defaultContentType ??
          'application/octet-stream';

        const body = fs.readFileSync(file.localPath);

        const putParams: PutObjectCommandInput = {
          Bucket: bucket,
          Key: file.s3Key,
          Body: body,
          ACL: acl,
          ContentType: contentType,
          ...file.s3Params,
        };

        await s3Client.send(new PutObjectCommand(putParams));

        completedOperations++;
        tracker.update(completedOperations, totalOperations);
      }),
    ),
  );

  // Delete removed files
  if (keysToDelete.length > 0) {
    for (let i = 0; i < keysToDelete.length; i += 1000) {
      const batch = keysToDelete.slice(i, i + 1000);
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    }
    completedOperations++;
    tracker.update(completedOperations, totalOperations);
  }
}
