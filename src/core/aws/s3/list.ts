import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { S3Object } from '@shared';

/**
 * Lists all objects in an S3 bucket with a prefix using an async generator
 * to be memory efficient.
 */
export async function* listAllObjects(
  s3Client: S3Client,
  bucket: string,
  prefix: string,
): AsyncGenerator<S3Object> {
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
          yield {
            Key: obj.Key,
            ETag: obj.ETag,
          };
        }
      }
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);
}
