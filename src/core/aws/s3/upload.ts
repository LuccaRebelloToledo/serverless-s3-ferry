import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  createProgressTracker,
  DEFAULT_MAX_CONCURRENCY,
  type ErrorLogger,
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
import { deleteObjectsByKeys } from './delete';
import { listAllObjects } from './list';

export interface UploadDirectoryOptions extends UploadDirOptions {
  s3Client: S3Client;
  progress: Plugin.Progress;
  servicePath: string;
  env?: string;
  log?: ErrorLogger;
}

interface FileProcessEntry {
  localPath: string;
  s3Key: string;
  s3Params: S3Params;
}

function computeMD5(content: Buffer): string {
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
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
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
    const s3Params = resolveS3Params(localFile, localDir, params, env);
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

  // Read, compare MD5, and upload in a single pass per file (inside pLimit)
  // Only maxConcurrency file buffers are in memory at any given time
  const limit = pLimit(maxConcurrency);
  await Promise.all(
    filesToProcess.map((entry) =>
      limit(async () => {
        const buffer = await fs.promises.readFile(entry.localPath);
        const localMD5 = computeMD5(buffer);

        // Check if file has changed by comparing MD5 with ETag
        const remote = remoteByKey.get(entry.s3Key);
        if (remote?.ETag && localMD5 === remote.ETag) {
          completedOperations++;
          tracker.update(completedOperations, totalOperations);
          return; // file unchanged
        }

        const contentType =
          mime.getType(entry.localPath) ??
          defaultContentType ??
          'application/octet-stream';

        const putParams: PutObjectCommandInput = {
          Bucket: bucket,
          Key: entry.s3Key,
          Body: buffer,
          ACL: acl,
          ContentType: contentType,
          ...entry.s3Params,
        };

        await s3Client.send(new PutObjectCommand(putParams));

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
