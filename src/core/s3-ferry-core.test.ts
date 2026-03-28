import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketTaggingCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { AwsProviderExtended, Plugin, RawBucketConfig } from '@shared';
import {
  mockAwsIam,
  mockProgress,
  mockProvider,
  TEST_BUCKET,
} from '@shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/aws/iam', () => mockAwsIam());

import { S3FerryCore } from './s3-ferry-core';

function mockLogging() {
  return {
    log: {
      error: vi.fn(),
      notice: vi.fn(),
      verbose: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    },
    progress: {
      create: vi.fn(() => mockProgress()),
    },
  } as unknown as Plugin.Logging;
}

describe('S3FerryCore', () => {
  const s3Mock = mockClient(S3Client);
  let tmpDir: string;

  beforeEach(() => {
    s3Mock.reset();
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3ferry-core-test-'));
  });

  afterEach(() => {
    s3Mock.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults offline to false when not provided', () => {
    const logging = mockLogging();
    const core = new S3FerryCore({
      provider: mockProvider() as unknown as AwsProviderExtended,
      rawConfig: [] as RawBucketConfig[],
      servicePath: '/tmp',
      log: logging.log,
      progress: logging.progress,
    });

    // offline defaults to false — isOffline() should return false
    expect((core as unknown as { isOffline: () => boolean }).isOffline()).toBe(
      false,
    );
  });

  it('performFullSync caches local files across sync and metadata phases', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');

    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(GetBucketTaggingCommand).resolves({ TagSet: [] });

    const logging = mockLogging();
    const core = new S3FerryCore({
      provider: mockProvider() as unknown as AwsProviderExtended,
      rawConfig: [
        {
          bucketName: TEST_BUCKET,
          localDir: '.',
          deleteRemoved: false,
          params: [{ '**/*.txt': { CacheControl: 'max-age=60' } }],
        },
      ] as RawBucketConfig[],
      servicePath: tmpDir,
      log: logging.log,
      progress: logging.progress,
    });

    await core.performFullSync();

    expect(logging.log.verbose).toHaveBeenCalledWith(
      'Synced files to S3 buckets',
    );
    expect(logging.log.verbose).toHaveBeenCalledWith('Synced bucket metadata');
  });

  it('performFullSync logs error and returns when no bucket configs exist', async () => {
    const logging = mockLogging();
    const core = new S3FerryCore({
      provider: mockProvider() as unknown as AwsProviderExtended,
      rawConfig: {} as unknown as RawBucketConfig[],
      servicePath: '/tmp',
      log: logging.log,
      progress: logging.progress,
    });

    await core.performFullSync();

    expect(logging.log.error).toHaveBeenCalledWith(
      'serverless-s3-ferry requires at least one configuration entry in custom.s3Ferry',
    );
  });
});
