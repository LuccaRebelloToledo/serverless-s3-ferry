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
  S3_MULTIPART_UPLOAD_PART_SIZE,
  S3_MULTIPART_UPLOAD_QUEUE_SIZE,
  type S3Object,
  type S3Params,
  toS3Path,
  type UploadDirOptions,
} from '@shared';
import mime from 'mime';
import { minimatch } from 'minimatch';
import pLimit from 'p-limit';
import { deleteObjectsByKeys } from './delete';
import { computeFileMD5 } from './hash';
import { listAllObjects } from './list';

export interface UploadDirectoryOptions extends UploadDirOptions {
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

function resolveS3Params(
  localFile: string,
  localDir: string,
  params?: ParamMatcher[],
  stage?: string,
): S3Params | null {
  if (!params || params.length === 0) {
    return {};
  }

  const s3Params: S3Params = {};
  let onlyForStage: string | undefined;

  for (const param of params) {
    if (minimatch(localFile, `${path.resolve(localDir)}/${param.glob}`)) {
      Object.assign(s3Params, param.params);
      if (s3Params['OnlyForStage']) {
        onlyForStage = s3Params['OnlyForStage'];
      }
    }
  }

  delete s3Params['OnlyForStage'];

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
    progress,
    stage,
    log,
  } = options;

  // Build a map of remote objects by key for quick lookup
  const remoteByKey = new Map<string, S3Object>();
  for await (const obj of listAllObjects(s3Client, bucket, prefix)) {
    remoteByKey.set(obj.Key, obj);
  }

  // Build list of candidate files and track local keys
  const filesToProcess: FileProcessEntry[] = [];
  const localKeys = new Set<string>();

  for await (const localFile of getLocalFiles(localDir, log)) {
    const relativePath = path.relative(localDir, localFile);
    const s3Key = prefix
      ? `${prefix}${toS3Path(relativePath)}`
      : toS3Path(relativePath);

    localKeys.add(s3Key);

    // Resolve per-file S3 params (may return null to skip)
    const s3Params = resolveS3Params(localFile, localDir, params, stage);
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

  const tracker = createProgressTracker(
    progress,
    (percent) => `${localDir}: sync with bucket ${bucket} (${percent}%)`,
  );

  // Stream, compare ETag/MD5, and upload in a single pass per file
  const limit = pLimit(maxConcurrency);
  await Promise.all(
    filesToProcess.map((entry) =>
      limit(async () => {
        // Check if file has changed by comparing MD5 with ETag
        const remote = remoteByKey.get(entry.s3Key);

        // For large files, multipart ETags have a different format (e.g. hash-number)
        // If it's a simple MD5 hash, we compare it.
        if (remote?.ETag && !remote.ETag.includes('-')) {
          const localMD5 = await computeFileMD5(entry.localPath);
          if (localMD5 === remote.ETag) {
            completedOperations++;
            tracker.update(completedOperations, totalOperations);
            return; // file unchanged
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
          // Optimal part size for multipart upload is 5MB by default
          queueSize: S3_MULTIPART_UPLOAD_QUEUE_SIZE, // concurrent parts per file
          partSize: S3_MULTIPART_UPLOAD_PART_SIZE,
          leavePartsOnError: false,
        });

        await parallelUploads3.done();

        completedOperations++;
        tracker.update(completedOperations, totalOperations);
      }),
    ),
  );

  // Delete removed files
  if (keysToDelete.length > 0) {
    await deleteObjectsByKeys(s3Client, bucket, keysToDelete);
    completedOperations++;
    tracker.update(completedOperations, totalOperations);
  }
}
