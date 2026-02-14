import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

  it('sends CopyObjectCommand with MetadataDirective REPLACE', async () => {
    s3Mock.on(CopyObjectCommand).resolves({});

    const client = new S3Client({});
    await copyObjectWithMetadata({
      s3Client: client,
      bucket: TEST_BUCKET,
      copySource: `${TEST_BUCKET}/key.txt`,
      key: 'key.txt',
      acl: 'private',
      extraParams: {},
    });

    const call = s3Mock.commandCalls(CopyObjectCommand)[0];
    expect(call.args[0].input.MetadataDirective).toBe('REPLACE');
    expect(call.args[0].input.Bucket).toBe(TEST_BUCKET);
    expect(call.args[0].input.Key).toBe('key.txt');
    expect(call.args[0].input.ACL).toBe('private');
    expect(call.args[0].input.ContentType).toBeUndefined();
  });

  it('includes contentType when provided', async () => {
    s3Mock.on(CopyObjectCommand).resolves({});

    const client = new S3Client({});
    await copyObjectWithMetadata({
      s3Client: client,
      bucket: TEST_BUCKET,
      copySource: 'b/k',
      key: 'k',
      acl: 'public-read',
      contentType: 'text/html',
      extraParams: {},
    });

    const call = s3Mock.commandCalls(CopyObjectCommand)[0];
    expect(call.args[0].input.ContentType).toBe('text/html');
  });

  it('merges extraParams', async () => {
    s3Mock.on(CopyObjectCommand).resolves({});

    const client = new S3Client({});
    await copyObjectWithMetadata({
      s3Client: client,
      bucket: TEST_BUCKET,
      copySource: 'b/k',
      key: 'k',
      acl: 'private',
      extraParams: { CacheControl: 'max-age=300' },
    });

    const call = s3Mock.commandCalls(CopyObjectCommand)[0];
    expect(call.args[0].input.CacheControl).toBe('max-age=300');
  });
});
