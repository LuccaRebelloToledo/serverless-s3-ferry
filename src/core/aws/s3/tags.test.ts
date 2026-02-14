import {
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { TEST_BUCKET } from '@shared';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeTags, updateBucketTags } from './tags';

describe('mergeTags', () => {
  it('adds new tags', () => {
    const existing = [{ Key: 'a', Value: '1' }];
    mergeTags(existing, [{ Key: 'b', Value: '2' }]);
    expect(existing).toEqual([
      { Key: 'a', Value: '1' },
      { Key: 'b', Value: '2' },
    ]);
  });

  it('updates existing tags', () => {
    const existing = [{ Key: 'a', Value: '1' }];
    mergeTags(existing, [{ Key: 'a', Value: '99' }]);
    expect(existing).toEqual([{ Key: 'a', Value: '99' }]);
  });

  it('handles empty tagsToMerge', () => {
    const existing = [{ Key: 'a', Value: '1' }];
    mergeTags(existing, []);
    expect(existing).toEqual([{ Key: 'a', Value: '1' }]);
  });
});

describe('updateBucketTags', () => {
  const s3Mock = mockClient(S3Client);

  beforeEach(() => {
    s3Mock.reset();
  });

  afterEach(() => {
    s3Mock.restore();
  });

  it('merges with existing tags', async () => {
    s3Mock.on(GetBucketTaggingCommand).resolves({
      TagSet: [{ Key: 'existing', Value: 'val' }],
    });
    s3Mock.on(PutBucketTaggingCommand).resolves({});

    const client = new S3Client({});
    await updateBucketTags(client, TEST_BUCKET, [{ Key: 'new', Value: 'tag' }]);

    const putCall = s3Mock.commandCalls(PutBucketTaggingCommand)[0];
    expect(putCall.args[0].input.Bucket).toBe(TEST_BUCKET);
    expect(putCall.args[0].input.Tagging?.TagSet).toEqual([
      { Key: 'existing', Value: 'val' },
      { Key: 'new', Value: 'tag' },
    ]);
  });

  it('creates tags when NoSuchTagSet', async () => {
    const noTagSetError = new Error('NoSuchTagSet');
    noTagSetError.name = 'NoSuchTagSet';
    s3Mock.on(GetBucketTaggingCommand).rejects(noTagSetError);
    s3Mock.on(PutBucketTaggingCommand).resolves({});

    const client = new S3Client({});
    await updateBucketTags(client, TEST_BUCKET, [{ Key: 'new', Value: 'tag' }]);

    const putCall = s3Mock.commandCalls(PutBucketTaggingCommand)[0];
    expect(putCall.args[0].input.Bucket).toBe(TEST_BUCKET);
    expect(putCall.args[0].input.Tagging?.TagSet).toEqual([
      { Key: 'new', Value: 'tag' },
    ]);
  });

  it('re-throws other errors', async () => {
    s3Mock.on(GetBucketTaggingCommand).rejects(new Error('AccessDenied'));

    const client = new S3Client({});
    await expect(
      updateBucketTags(client, TEST_BUCKET, [{ Key: 'a', Value: 'b' }]),
    ).rejects.toThrow('AccessDenied');
  });
});
