import { DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  createProgressTracker,
  type Plugin,
  S3_DELETE_BATCH_SIZE,
} from '@shared';
import { listAllObjects } from './list';

export interface DeleteDirOptions {
  s3Client: S3Client;
  bucket: string;
  prefix: string;
  progress: Plugin.Progress;
}

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

export async function deleteDirectory(
  options: DeleteDirOptions,
): Promise<void> {
  const { s3Client, bucket, prefix, progress } = options;

  const objects = await listAllObjects(s3Client, bucket, prefix);
  const allKeys = objects.map((obj) => obj.Key);

  if (allKeys.length === 0) {
    return;
  }

  const tracker = createProgressTracker(
    progress,
    (percent) =>
      `${bucket}: removing files with prefix ${prefix} (${percent}%)`,
  );

  await deleteObjectsByKeys(s3Client, bucket, allKeys, (deletedSoFar, total) =>
    tracker.update(deletedSoFar, total),
  );
}
