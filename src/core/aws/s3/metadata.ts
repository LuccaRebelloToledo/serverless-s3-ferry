import path from 'node:path';
import type { ObjectCannedACL, S3Client } from '@aws-sdk/client-s3';
import {
  DEFAULT_MAX_CONCURRENCY,
  type ErrorLogger,
  encodeSpecialCharacters,
  extractMetaParams,
  type FileToSync,
  getLocalFiles,
  IGNORED_FILES,
  ONLY_FOR_STAGE_KEY,
  type ParamEntry,
  type Plugin,
  toS3Path,
} from '@shared';
import mime from 'mime';
import { minimatch } from 'minimatch';
import pLimit from 'p-limit';
import { copyObjectWithMetadata } from './copy';

interface SyncMetadataOptions {
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
  localFiles?: string[];
}

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

  const resolvedLocalDir = path.resolve(localDir);
  const resolvedLocalDirPrefix = resolvedLocalDir + path.sep;

  const fileMap = new Map<string, FileToSync>();
  const ignored = new Set<string>(IGNORED_FILES);
  const files = options.localFiles ?? getLocalFiles({ dir: localDir, log });

  for (const param of params) {
    const glob = Object.keys(param)[0];
    const matchParams = extractMetaParams(param);
    const matches = minimatch.match(
      files,
      `${resolvedLocalDir}${path.sep}${glob}`,
      { matchBase: true },
    );

    const skipStage =
      !!matchParams[ONLY_FOR_STAGE_KEY] &&
      matchParams[ONLY_FOR_STAGE_KEY] !== stage;
    delete matchParams[ONLY_FOR_STAGE_KEY];

    for (const match of matches) {
      if (ignored.has(match)) continue;
      if (skipStage) {
        ignored.add(match);
        fileMap.delete(match);
        continue;
      }
      fileMap.set(match, { name: match, params: matchParams });
    }
  }

  const filesToSync = Array.from(fileMap.values());

  const bucketDir = `${bucket}${normalizedPrefix === '' ? '' : normalizedPrefix}/`;

  const limit = pLimit(DEFAULT_MAX_CONCURRENCY);
  await Promise.all(
    filesToSync.map((file) =>
      limit(async () => {
        let contentType: string | undefined;
        const detectedContentType = mime.getType(file.name);
        if (detectedContentType !== null || defaultContentType) {
          contentType = detectedContentType ?? defaultContentType;
        }

        const copySource = encodeSpecialCharacters(
          toS3Path(file.name.replace(resolvedLocalDirPrefix, bucketDir)),
        );

        const key = encodeSpecialCharacters(
          toS3Path(
            file.name.replace(
              resolvedLocalDirPrefix,
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
      }),
    ),
  );

  const percent = filesToSync.length > 0 ? 100 : 0;
  progress.update(
    `${localDir}: sync bucket metadata to ${bucketDir} (${percent}%)`,
  );
}
