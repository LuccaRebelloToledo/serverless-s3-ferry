import {
  CopyObjectCommand,
  type CopyObjectCommandInput,
  type ObjectCannedACL,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { S3Params } from '@shared';

export interface CopyObjectOptions {
  s3Client: S3Client;
  bucket: string;
  copySource: string;
  key: string;
  acl: ObjectCannedACL;
  contentType?: string;
  extraParams: S3Params;
}

export async function copyObjectWithMetadata(
  options: CopyObjectOptions,
): Promise<void> {
  const { s3Client, bucket, copySource, key, acl, contentType, extraParams } =
    options;

  const params: CopyObjectCommandInput = {
    ...extraParams,
    CopySource: copySource,
    Key: key,
    Bucket: bucket,
    ACL: acl,
    MetadataDirective: 'REPLACE',
  };

  if (contentType) {
    params.ContentType = contentType;
  }

  await s3Client.send(new CopyObjectCommand(params));
}
