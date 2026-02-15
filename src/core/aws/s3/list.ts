import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { S3Object } from '@shared';

export async function listAllObjects(
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
