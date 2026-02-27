import { DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import { type Plugin, S3_DELETE_BATCH_SIZE } from '@shared';
import { listAllObjects } from './list';

export interface DeleteDirOptions {
  s3Client: S3Client;
  bucket: string;
  prefix: string;
  progress: Plugin.Progress;
}

/**
 * Deletes S3 objects in batches of up to 1000 keys (AWS limit).
 */
export async function deleteObjectsByKeys(
  s3Client: S3Client,
  bucket: string,
  keys: string[],
  onBatch?: (deletedSoFar: number, total: number) => void,
): Promise<void> {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += S3_DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + S3_DELETE_BATCH_SIZE);
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
    deleted += batch.length;
    onBatch?.(deleted, keys.length);
  }
}

/**
 * Lists and deletes all objects in an S3 bucket that match the specified prefix.
 */
export async function deleteDirectory(
  options: DeleteDirOptions,
): Promise<void> {
  const { s3Client, bucket, prefix, progress } = options;

  let currentBatch: string[] = [];
  let totalDeleted = 0;

  for await (const obj of listAllObjects(s3Client, bucket, prefix)) {
    if (obj.Key) {
      currentBatch.push(obj.Key);
    }

    if (currentBatch.length >= S3_DELETE_BATCH_SIZE) {
      await deleteObjectsByKeys(s3Client, bucket, currentBatch);
      totalDeleted += currentBatch.length;
      currentBatch = [];
      progress.update(
        `${bucket}: removing files with prefix ${prefix} (${totalDeleted} objects removed)`,
      );
    }
  }

  if (currentBatch.length > 0) {
    await deleteObjectsByKeys(s3Client, bucket, currentBatch);
    totalDeleted += currentBatch.length;
  }

  progress.update(`${bucket}: removing files with prefix ${prefix} (100%)`);
}
