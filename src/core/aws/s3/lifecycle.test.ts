import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3_FERRY_LIFECYCLE_RULE_ID } from '@shared';
import { TEST_BUCKET } from '@shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureAbortIncompleteMultipartUploadRule } from './lifecycle';

describe('ensureAbortIncompleteMultipartUploadRule', () => {
  const s3Mock = mockClient(S3Client);

  beforeEach(() => {
    s3Mock.reset();
  });

  afterEach(() => {
    s3Mock.restore();
  });

  it('creates lifecycle rule when no configuration exists', async () => {
    const noConfigError = new Error('NoSuchLifecycleConfiguration');
    noConfigError.name = 'NoSuchLifecycleConfiguration';
    s3Mock.on(GetBucketLifecycleConfigurationCommand).rejects(noConfigError);
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});

    const client = new S3Client({});
    await ensureAbortIncompleteMultipartUploadRule({
      s3Client: client,
      bucket: TEST_BUCKET,
      daysAfterInitiation: 7,
    });

    const putCall = s3Mock.commandCalls(
      PutBucketLifecycleConfigurationCommand,
    )[0];
    if (!putCall)
      throw new Error('Expected PutBucketLifecycleConfigurationCommand call');
    const rules = putCall.args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.ID).toBe(S3_FERRY_LIFECYCLE_RULE_ID);
    expect(rules[0]?.Status).toBe('Enabled');
    expect(rules[0]?.AbortIncompleteMultipartUpload?.DaysAfterInitiation).toBe(
      7,
    );
  });

  it('preserves existing rules and adds abort rule', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        {
          ID: 'existing-rule',
          Status: 'Enabled',
          Filter: { Prefix: 'logs/' },
          Expiration: { Days: 30 },
        },
      ],
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});

    const client = new S3Client({});
    await ensureAbortIncompleteMultipartUploadRule({
      s3Client: client,
      bucket: TEST_BUCKET,
      daysAfterInitiation: 7,
    });

    const putCall = s3Mock.commandCalls(
      PutBucketLifecycleConfigurationCommand,
    )[0];
    if (!putCall)
      throw new Error('Expected PutBucketLifecycleConfigurationCommand call');
    const rules = putCall.args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect(rules).toHaveLength(2);
    expect(rules[0]?.ID).toBe('existing-rule');
    expect(rules[1]?.ID).toBe(S3_FERRY_LIFECYCLE_RULE_ID);
  });

  it('updates existing s3-ferry rule instead of duplicating', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        {
          ID: S3_FERRY_LIFECYCLE_RULE_ID,
          Status: 'Enabled',
          Filter: { Prefix: '' },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
        },
      ],
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});

    const client = new S3Client({});
    await ensureAbortIncompleteMultipartUploadRule({
      s3Client: client,
      bucket: TEST_BUCKET,
      daysAfterInitiation: 14,
    });

    const putCall = s3Mock.commandCalls(
      PutBucketLifecycleConfigurationCommand,
    )[0];
    if (!putCall)
      throw new Error('Expected PutBucketLifecycleConfigurationCommand call');
    const rules = putCall.args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.ID).toBe(S3_FERRY_LIFECYCLE_RULE_ID);
    expect(rules[0]?.AbortIncompleteMultipartUpload?.DaysAfterInitiation).toBe(
      14,
    );
  });

  it('handles undefined Rules in response', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: undefined,
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});

    const client = new S3Client({});
    await ensureAbortIncompleteMultipartUploadRule({
      s3Client: client,
      bucket: TEST_BUCKET,
      daysAfterInitiation: 7,
    });

    const putCall = s3Mock.commandCalls(
      PutBucketLifecycleConfigurationCommand,
    )[0];
    if (!putCall)
      throw new Error('Expected PutBucketLifecycleConfigurationCommand call');
    const rules = putCall.args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.ID).toBe(S3_FERRY_LIFECYCLE_RULE_ID);
  });

  it('re-throws other errors', async () => {
    s3Mock
      .on(GetBucketLifecycleConfigurationCommand)
      .rejects(new Error('AccessDenied'));

    const client = new S3Client({});
    await expect(
      ensureAbortIncompleteMultipartUploadRule({
        s3Client: client,
        bucket: TEST_BUCKET,
        daysAfterInitiation: 7,
      }),
    ).rejects.toThrow('AccessDenied');
  });

  it('uses custom daysAfterInitiation', async () => {
    const noConfigError = new Error('NoSuchLifecycleConfiguration');
    noConfigError.name = 'NoSuchLifecycleConfiguration';
    s3Mock.on(GetBucketLifecycleConfigurationCommand).rejects(noConfigError);
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});

    const client = new S3Client({});
    await ensureAbortIncompleteMultipartUploadRule({
      s3Client: client,
      bucket: TEST_BUCKET,
      daysAfterInitiation: 3,
    });

    const putCall = s3Mock.commandCalls(
      PutBucketLifecycleConfigurationCommand,
    )[0];
    if (!putCall)
      throw new Error('Expected PutBucketLifecycleConfigurationCommand call');
    const rules = putCall.args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect(rules[0]?.AbortIncompleteMultipartUpload?.DaysAfterInitiation).toBe(
      3,
    );
  });

  it('scopes lifecycle rule to the provided prefix', async () => {
    const noConfigError = new Error('NoSuchLifecycleConfiguration');
    noConfigError.name = 'NoSuchLifecycleConfiguration';
    s3Mock.on(GetBucketLifecycleConfigurationCommand).rejects(noConfigError);
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});

    const client = new S3Client({});
    await ensureAbortIncompleteMultipartUploadRule({
      s3Client: client,
      bucket: TEST_BUCKET,
      prefix: 'assets/',
      daysAfterInitiation: 7,
    });

    const putCall = s3Mock.commandCalls(
      PutBucketLifecycleConfigurationCommand,
    )[0];
    if (!putCall)
      throw new Error('Expected PutBucketLifecycleConfigurationCommand call');
    const rules = putCall.args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect(rules[0]?.Filter?.Prefix).toBe('assets/');
  });

  it('defaults prefix to empty string when not provided', async () => {
    const noConfigError = new Error('NoSuchLifecycleConfiguration');
    noConfigError.name = 'NoSuchLifecycleConfiguration';
    s3Mock.on(GetBucketLifecycleConfigurationCommand).rejects(noConfigError);
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});

    const client = new S3Client({});
    await ensureAbortIncompleteMultipartUploadRule({
      s3Client: client,
      bucket: TEST_BUCKET,
      daysAfterInitiation: 7,
    });

    const putCall = s3Mock.commandCalls(
      PutBucketLifecycleConfigurationCommand,
    )[0];
    if (!putCall)
      throw new Error('Expected PutBucketLifecycleConfigurationCommand call');
    const rules = putCall.args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect(rules[0]?.Filter?.Prefix).toBe('');
  });
});
