import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  type CopyObjectCommandInput,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  type ObjectCannedACL,
  type S3Client,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import {
  S3_COPY_METADATA_DIRECTIVE,
  S3_MAX_SIMPLE_COPY_SIZE,
  S3_MULTIPART_COPY_PART_SIZE,
  type S3Params,
} from '@shared';

export interface CopyObjectOptions {
  s3Client: S3Client;
  bucket: string;
  copySource: string;
  key: string;
  acl: ObjectCannedACL;
  contentType?: string;
  extraParams: S3Params;
}

/**
 * Copies an S3 object with metadata, supporting both simple copy (<5GB)
 * and multipart copy (>=5GB).
 */
export async function copyObjectWithMetadata(
  options: CopyObjectOptions,
): Promise<void> {
  const { s3Client, bucket, copySource, key, acl, contentType, extraParams } =
    options;

  // 1. Get object size to decide between simple and multipart copy
  // CopySource format: bucket/key (already URL encoded by encodeSpecialCharacters)
  const sourceBucket = copySource.split('/')[0];
  const sourceKey = decodeURIComponent(
    copySource.split('/').slice(1).join('/'),
  );

  const headResponse = await s3Client.send(
    new HeadObjectCommand({
      Bucket: sourceBucket,
      Key: sourceKey,
    }),
  );

  const objectSize = headResponse.ContentLength ?? 0;

  // 2. Branch: Simple Copy (< 5GB)
  if (objectSize < S3_MAX_SIMPLE_COPY_SIZE) {
    const params: CopyObjectCommandInput = {
      ...extraParams,
      CopySource: copySource,
      Key: key,
      Bucket: bucket,
      ACL: acl,
      MetadataDirective: S3_COPY_METADATA_DIRECTIVE,
    };

    if (contentType) {
      params.ContentType = contentType;
    }

    await s3Client.send(new CopyObjectCommand(params));
    return;
  }

  // 3. Branch: Multipart Copy (>= 5GB)
  // a. Create multipart upload
  const createResponse = await s3Client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ACL: acl,
      ContentType: contentType,
      ...extraParams,
    }),
  );

  const uploadId = createResponse.UploadId;

  try {
    const parts = [];

    // b. Upload parts using UploadPartCopy
    let partNumber = 1;
    for (
      let start = 0;
      start < objectSize;
      start += S3_MULTIPART_COPY_PART_SIZE
    ) {
      const end = Math.min(
        start + S3_MULTIPART_COPY_PART_SIZE - 1,
        objectSize - 1,
      );
      const copyRange = `bytes=${start}-${end}`;

      const partResponse = await s3Client.send(
        new UploadPartCopyCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          CopySource: copySource,
          CopySourceRange: copyRange,
        }),
      );

      parts.push({
        ETag: partResponse.CopyPartResult?.ETag,
        PartNumber: partNumber,
      });

      partNumber++;
    }

    // c. Complete multipart upload
    await s3Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts,
        },
      }),
    );
  } catch (error) {
    // Abort orphaned multipart upload to prevent storage cost accumulation
    await s3Client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
    throw error;
  }
}
