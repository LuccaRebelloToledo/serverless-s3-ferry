import path from 'node:path';
import type { ObjectCannedACL, S3Client } from '@aws-sdk/client-s3';
import {
  DEFAULT_MAX_CONCURRENCY,
  type ErrorLogger,
  encodeSpecialCharacters,
  extractMetaParams,
  type FileToSync,
  getLocalFiles,
  type ParamEntry,
  type Plugin,
  toS3Path,
} from '@shared';
import mime from 'mime';
import { minimatch } from 'minimatch';
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
  const ignoredNames = new Set<string>(['.DS_Store']);
  const stageIgnoredFiles = new Set<string>();

  for await (const localFile of getLocalFiles(localDir, log)) {
    if (ignoredNames.has(path.basename(localFile))) continue;

    const relativePath = path.relative(localDir, localFile);

    for (const param of params) {
      const glob = Object.keys(param)[0];
      if (!glob) continue;

      if (minimatch(relativePath, glob)) {
        const matchParams = extractMetaParams(param);
        if (
          matchParams['OnlyForStage'] &&
          matchParams['OnlyForStage'] !== stage
        ) {
          stageIgnoredFiles.add(localFile);
          fileMap.delete(localFile);
          break;
        }
        delete matchParams['OnlyForStage'];

        fileMap.set(localFile, { name: localFile, params: matchParams });
      }
    }
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

  await Promise.all(
    filesToSync.map((file) =>
      limit(async () => {
        let contentType: string | undefined;
        const detectedContentType = mime.getType(file.name);
        if (detectedContentType !== null || defaultContentType) {
          contentType = detectedContentType ?? defaultContentType;
        }

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
        const percent = Math.round((completed / filesToSync.length) * 100);
        progress.update(
          `${localDir}: sync bucket metadata to ${bucketDir} (${percent}%)`,
        );
      }),
    ),
  );

  if (filesToSync.length === 0) {
    progress.update(`${localDir}: sync bucket metadata to ${bucketDir} (0%)`);
  }
}
