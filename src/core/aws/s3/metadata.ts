import path from 'node:path';
import type { ObjectCannedACL, S3Client } from '@aws-sdk/client-s3';
import {
  buildParamMatchers,
  createProgressTracker,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_MAX_CONCURRENCY,
  type ErrorLogger,
  encodeSpecialCharacters,
  type FileToSync,
  getLocalFiles,
  type ParamEntry,
  type Plugin,
  resolveS3Params,
  toS3Path,
} from '@shared';
import mime from 'mime';
import pLimit from 'p-limit';
import { copyObjectWithMetadata } from './copy';

export interface SyncMetadataOptions {
  s3Client: S3Client;
  localDir: string;
  bucket: string;
  bucketPrefix: string;
  acl: ObjectCannedACL;
  defaultContentType?: string;
  params: ParamEntry[];
  stage?: string;
  progress: Plugin.Progress;
  log?: ErrorLogger;
}

interface GetFilesToSyncOptions {
  localDir: string;
  params: ParamEntry[];
  stage?: string;
  log?: ErrorLogger;
}

/**
 * Identifies local files that match the provided parameters and should have their metadata synced.
 */
async function getFilesToSync(
  options: GetFilesToSyncOptions,
): Promise<FileToSync[]> {
  const { localDir, params, stage, log } = options;
  const fileMap = new Map<string, FileToSync>();
  const paramMatchers = buildParamMatchers(params);

  for await (const localFile of getLocalFiles(localDir, log)) {
    const relativePath = toS3Path(path.relative(localDir, localFile));
    const s3Params = resolveS3Params({
      relativePath,
      params: paramMatchers,
      stage,
      skipUnmatched: true,
    });

    if (s3Params === null) {
      continue;
    }

    fileMap.set(localFile, { name: localFile, params: s3Params });
  }

  return Array.from(fileMap.values());
}

/**
 * Syncs metadata (ACL, Content-Type, etc.) for files that already exist in S3.
 * This is useful when you want to update headers without re-uploading the file content.
 */
export async function syncDirectoryMetadata(
  options: SyncMetadataOptions,
): Promise<void> {
  const {
    s3Client,
    localDir,
    bucket,
    bucketPrefix,
    acl,
    defaultContentType,
    params,
    stage,
    progress,
    log,
  } = options;

  let normalizedPrefix = '';
  if (bucketPrefix.length > 0) {
    normalizedPrefix = bucketPrefix.replace(/\/?$/, '').replace(/^\/?/, '/');
  }

  const filesToSync = await getFilesToSync({ localDir, params, stage, log });
  const bucketDir = `${bucket}${normalizedPrefix === '' ? '' : normalizedPrefix}/`;
  const resolvedLocalDir = path.resolve(localDir) + path.sep;

  const limit = pLimit(DEFAULT_MAX_CONCURRENCY);
  let completed = 0;

  const tracker = createProgressTracker(
    progress,
    (percent) =>
      `${localDir}: sync bucket metadata to ${bucketDir} (${percent}%)`,
  );

  await Promise.all(
    filesToSync.map((file) =>
      limit(async () => {
        const contentType =
          mime.getType(file.name) ?? defaultContentType ?? DEFAULT_CONTENT_TYPE;

        const copySource = encodeSpecialCharacters(
          toS3Path(file.name.replace(resolvedLocalDir, bucketDir)),
        );

        const key = encodeSpecialCharacters(
          toS3Path(
            file.name.replace(
              resolvedLocalDir,
              normalizedPrefix ? `${normalizedPrefix.replace(/^\//, '')}/` : '',
            ),
          ),
        );

        await copyObjectWithMetadata({
          s3Client,
          bucket,
          copySource,
          key,
          acl,
          contentType,
          extraParams: file.params,
        });

        completed++;
        tracker.update(completed, filesToSync.length);
      }),
    ),
  );

  if (filesToSync.length === 0) {
    progress.update(`${localDir}: sync bucket metadata to ${bucketDir} (0%)`);
  }
}
