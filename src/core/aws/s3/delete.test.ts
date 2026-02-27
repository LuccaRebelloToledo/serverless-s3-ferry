import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockProgress, TEST_BUCKET } from '@shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteDirectory } from './delete';

describe('deleteDirectory', () => {
  const s3Mock = mockClient(S3Client);

  beforeEach(() => {
    s3Mock.reset();
  });

  afterEach(() => {
    s3Mock.restore();
  });

  it('deletes all objects with prefix', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'prefix/a.txt' }, { Key: 'prefix/b.txt' }],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const client = new S3Client({});
    await deleteDirectory({
      s3Client: client,
      bucket: TEST_BUCKET,
      prefix: 'prefix/',
      progress: mockProgress(),
    });

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(1);
    const deleteCall = deleteCalls[0];
    if (!deleteCall) throw new Error('Expected DeleteObjectsCommand call');
    expect(deleteCall.args[0].input.Delete?.Objects).toEqual([
      { Key: 'prefix/a.txt' },
      { Key: 'prefix/b.txt' },
    ]);
  });

  it('handles pagination', async () => {
    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: 'a.txt' }],
        IsTruncated: true,
        NextContinuationToken: 'token1',
      })
      .resolvesOnce({
        Contents: [{ Key: 'b.txt' }],
        IsTruncated: false,
      });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const client = new S3Client({});
    await deleteDirectory({
      s3Client: client,
      bucket: TEST_BUCKET,
      prefix: '',
      progress: mockProgress(),
    });

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    const deleteCall = deleteCalls[0];
    if (!deleteCall) throw new Error('Expected DeleteObjectsCommand call');
    expect(deleteCall.args[0].input.Delete?.Objects).toEqual([
      { Key: 'a.txt' },
      { Key: 'b.txt' },
    ]);
  });

  it('batches deletes in groups of 1000', async () => {
    const contents = Array.from({ length: 1500 }, (_, i) => ({
      Key: `file-${i}.txt`,
    }));
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: contents,
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const client = new S3Client({});
    await deleteDirectory({
      s3Client: client,
      bucket: TEST_BUCKET,
      prefix: '',
      progress: mockProgress(),
    });

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(2);
    const deleteCall0 = deleteCalls[0];
    const deleteCall1 = deleteCalls[1];
    if (!deleteCall0 || !deleteCall1)
      throw new Error('Expected DeleteObjectsCommand calls');
    expect(deleteCall0.args[0].input.Delete?.Objects).toHaveLength(1000);
    expect(deleteCall1.args[0].input.Delete?.Objects).toHaveLength(500);
  });

  it('does nothing when Contents is undefined', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      IsTruncated: false,
    });

    const client = new S3Client({});
    await deleteDirectory({
      s3Client: client,
      bucket: TEST_BUCKET,
      prefix: '',
      progress: mockProgress(),
    });

    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  it('does nothing for empty bucket', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [],
      IsTruncated: false,
    });

    const client = new S3Client({});
    await deleteDirectory({
      s3Client: client,
      bucket: TEST_BUCKET,
      prefix: '',
      progress: mockProgress(),
    });

    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  it('skips objects without keys', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ ETag: '"a"' }, { Key: 'valid.txt' }],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const client = new S3Client({});
    await deleteDirectory({
      s3Client: client,
      bucket: TEST_BUCKET,
      prefix: '',
      progress: mockProgress(),
    });

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(1);
    // Only valid.txt should be in the batch, covering the obj.Key check
    expect(deleteCalls[0]?.args[0].input.Delete?.Objects).toEqual([
      { Key: 'valid.txt' },
    ]);
  });
});
