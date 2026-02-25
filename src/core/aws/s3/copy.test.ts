import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import { TEST_BUCKET } from '@shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyObjectWithMetadata } from './copy';

describe('copyObjectWithMetadata', () => {
  const s3Mock = mockClient(S3Client);

  beforeEach(() => {
    s3Mock.reset();
  });

  afterEach(() => {
    s3Mock.restore();
  });

  describe('Simple Copy (< 5GB)', () => {
    it('uses simple CopyObjectCommand for small files', async () => {
      s3Mock.on(HeadObjectCommand).resolves({
        ContentLength: 1024 * 1024 * 100, // 100MB
      });
      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await copyObjectWithMetadata({
        s3Client: client,
        bucket: TEST_BUCKET,
        copySource: `${TEST_BUCKET}/key.txt`,
        key: 'key.txt',
        acl: 'private',
        extraParams: { CacheControl: 'max-age=300' },
      });

      expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(1);
      const call = s3Mock.commandCalls(CopyObjectCommand)[0];
      expect(call?.args[0].input.MetadataDirective).toBe('REPLACE');
      expect(call?.args[0].input.CacheControl).toBe('max-age=300');
    });
  });

  describe('Multipart Copy (>= 5GB)', () => {
    it('orchestrates multipart copy for large files', async () => {
      const TWELVE_GB = 12 * 1024 * 1024 * 1024;
      s3Mock.on(HeadObjectCommand).resolves({
        ContentLength: TWELVE_GB,
      });
      s3Mock.on(CreateMultipartUploadCommand).resolves({
        UploadId: 'upload-id-123',
      });
      s3Mock.on(UploadPartCopyCommand).resolves({
        CopyPartResult: { ETag: 'etag-part' },
      });
      s3Mock.on(CompleteMultipartUploadCommand).resolves({});

      const client = new S3Client({});
      await copyObjectWithMetadata({
        s3Client: client,
        bucket: TEST_BUCKET,
        copySource: `${TEST_BUCKET}/large-file.zip`,
        key: 'large-file.zip',
        acl: 'private',
        contentType: 'application/zip',
        extraParams: { StorageClass: 'INTELLIGENT_TIERING' },
      });

      // 1. Check HeadObject
      expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(1);

      // 2. Check Multipart Init
      expect(s3Mock.commandCalls(CreateMultipartUploadCommand)).toHaveLength(1);
      const createCall = s3Mock.commandCalls(CreateMultipartUploadCommand)[0];
      expect(createCall?.args[0].input.StorageClass).toBe(
        'INTELLIGENT_TIERING',
      );
      expect(createCall?.args[0].input.ContentType).toBe('application/zip');

      // 3. Check Parts (12GB / 5GB = 3 parts: 0-5G, 5-10G, 10-12G)
      const partCalls = s3Mock.commandCalls(UploadPartCopyCommand);
      expect(partCalls).toHaveLength(3);
      expect(partCalls[0]?.args[0].input.CopySourceRange).toBe(
        'bytes=0-5368709119',
      );
      expect(partCalls[1]?.args[0].input.CopySourceRange).toBe(
        'bytes=5368709120-10737418239',
      );
      expect(partCalls[2]?.args[0].input.CopySourceRange).toBe(
        'bytes=10737418240-12884901887',
      );

      // 4. Check Complete
      expect(s3Mock.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(
        1,
      );
      const completeCall = s3Mock.commandCalls(
        CompleteMultipartUploadCommand,
      )[0];
      expect(completeCall?.args[0].input.MultipartUpload?.Parts).toHaveLength(
        3,
      );
    });
  });
});
