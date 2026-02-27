import fs from 'node:fs';
import path from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import {
  createProgressTracker,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_MAX_CONCURRENCY,
  type ErrorLogger,
  getLocalFiles,
  type ParamMatcher,
  type Plugin,
  resolveS3Params,
  S3_MULTIPART_UPLOAD_PART_SIZE,
  S3_MULTIPART_UPLOAD_QUEUE_SIZE,
  type S3Object,
  type S3Params,
  toS3Path,
  type UploadDirOptions,
} from '@shared';
import mime from 'mime';
import pLimit from 'p-limit';
import { deleteObjectsByKeys } from './delete';
import { computeFileMD5 } from './hash';
import { listAllObjects } from './list';

export interface UploadDirectoryOptions extends UploadDirOptions {
  s3Client: S3Client;
  maxConcurrency?: number;
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

interface GetRemoteObjectsMapOptions {
  s3Client: S3Client;
  bucket: string;
  prefix: string;
}

/**
 * Builds a map of remote objects by key for quick lookup.
 */
async function getRemoteObjectsMap(
  options: GetRemoteObjectsMapOptions,
): Promise<Map<string, S3Object>> {
  const { s3Client, bucket, prefix } = options;
  const remoteByKey = new Map<string, S3Object>();
  for await (const obj of listAllObjects(s3Client, bucket, prefix)) {
    remoteByKey.set(obj.Key, obj);
  }
  return remoteByKey;
}

interface GetFilesToProcessOptions {
  localDir: string;
  prefix: string;
  params?: ParamMatcher[];
  stage?: string;
  log?: ErrorLogger;
}

interface FilesToProcessResult {
  files: FileProcessEntry[];
  localKeys: Set<string>;
}

/**
 * Lists local files and maps them to S3 keys and parameters.
 */
async function getFilesToProcess(
  options: GetFilesToProcessOptions,
): Promise<FilesToProcessResult> {
  const { localDir, prefix, params, stage, log } = options;
  const files: FileProcessEntry[] = [];
  const localKeys = new Set<string>();

  for await (const localFile of getLocalFiles(localDir, log)) {
    const normalizedPath = toS3Path(path.relative(localDir, localFile));
    const s3Key = prefix
      ? `${prefix.replace(/\/?$/, '/')}${normalizedPath}`
      : normalizedPath;

    localKeys.add(s3Key);

    const s3Params = resolveS3Params({
      relativePath: normalizedPath,
      params,
      stage,
    });
    if (s3Params === null) {
      continue;
    }

    files.push({ localPath: localFile, s3Key, s3Params });
  }

  return { files, localKeys };
}

interface GetKeysToDeleteOptions {
  remoteKeys: IterableIterator<string>;
  localKeys: Set<string>;
  deleteRemoved: boolean;
}

/**
 * Determines which remote keys should be deleted.
 */
function getKeysToDelete(options: GetKeysToDeleteOptions): string[] {
  const { remoteKeys, localKeys, deleteRemoved } = options;
  if (!deleteRemoved) {
    return [];
  }

  const keysToDelete: string[] = [];
  for (const remoteKey of remoteKeys) {
    if (!localKeys.has(remoteKey)) {
      keysToDelete.push(remoteKey);
    }
  }
  return keysToDelete;
}

/**
 * Syncs a local directory with an S3 bucket by uploading changed files
 * and optionally deleting removed ones.
 */
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
    progress,
    stage,
    log,
  } = options;

  const remoteByKey = await getRemoteObjectsMap({ s3Client, bucket, prefix });
  const { files: filesToProcess, localKeys } = await getFilesToProcess({
    localDir,
    prefix,
    params,
    stage,
    log,
  });

  const keysToDelete = getKeysToDelete({
    remoteKeys: remoteByKey.keys(),
    localKeys,
    deleteRemoved,
  });

  const totalOperations =
    filesToProcess.length + (keysToDelete.length > 0 ? 1 : 0);
  let completedOperations = 0;

  const tracker = createProgressTracker(
    progress,
    (percent) => `${localDir}: sync with bucket ${bucket} (${percent}%)`,
  );

  const limit = pLimit(maxConcurrency);
  await Promise.all(
    filesToProcess.map((entry) =>
      limit(async () => {
        const remote = remoteByKey.get(entry.s3Key);

        if (remote?.ETag && !remote.ETag.includes('-')) {
          const localMD5 = await computeFileMD5(entry.localPath);
          if (localMD5 === remote.ETag) {
            completedOperations++;
            tracker.update(completedOperations, totalOperations);
            return;
          }
        }

        const contentType =
          mime.getType(entry.localPath) ??
          defaultContentType ??
          DEFAULT_CONTENT_TYPE;

        const parallelUploads3 = new Upload({
          client: s3Client,
          params: {
            Bucket: bucket,
            Key: entry.s3Key,
            Body: fs.createReadStream(entry.localPath),
            ACL: acl,
            ContentType: contentType,
            ...entry.s3Params,
          },
          queueSize: S3_MULTIPART_UPLOAD_QUEUE_SIZE,
          partSize: S3_MULTIPART_UPLOAD_PART_SIZE,
          leavePartsOnError: false,
        });

        await parallelUploads3.done();

        completedOperations++;
        tracker.update(completedOperations, totalOperations);
      }),
    ),
  );

  if (keysToDelete.length > 0) {
    await deleteObjectsByKeys(s3Client, bucket, keysToDelete);
    completedOperations++;
    tracker.update(completedOperations, totalOperations);
  }
}
