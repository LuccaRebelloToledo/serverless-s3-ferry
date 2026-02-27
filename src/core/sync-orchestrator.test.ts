import child_process from 'node:child_process';
import path from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import type {
  BucketSyncConfig,
  Plugin,
  RawBucketConfig,
  S3FerryOptions,
} from '@shared';
import { mockProgress } from '@shared/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as s3Ops from './aws/s3';
import {
  SyncOrchestrator,
  type SyncOrchestratorOptions,
} from './sync-orchestrator';

vi.mock('node:child_process');
vi.mock('./aws/s3');

describe('SyncOrchestrator', () => {
  let options: SyncOrchestratorOptions;
  let orchestrator: SyncOrchestrator;
  const mockS3Client = {} as S3Client;

  beforeEach(() => {
    vi.clearAllMocks();

    options = {
      s3Client: mockS3Client,
      servicePath: '/test/path',
      options: {} as S3FerryOptions,
      log: {
        error: vi.fn(),
        notice: vi.fn(),
        verbose: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
      } as unknown as Plugin.Logging['log'],
      progress: {
        create: vi.fn(() => mockProgress()),
      } as unknown as Plugin.Logging['progress'],
      getBucketName: vi.fn(
        async (config: BucketSyncConfig | RawBucketConfig) =>
          config.bucketName || 'test-bucket',
      ),
    };

    orchestrator = new SyncOrchestrator(options);
  });

  describe('sync()', () => {
    it('executes uploadDirectory for enabled buckets', async () => {
      const rawBuckets: RawBucketConfig[] = [
        { bucketName: 'bucket-1', localDir: 'dir1' },
        { bucketName: 'bucket-2', localDir: 'dir2', enabled: false },
      ];

      await orchestrator.sync(rawBuckets);

      expect(s3Ops.uploadDirectory).toHaveBeenCalledTimes(1);
      expect(s3Ops.uploadDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: 'bucket-1',
          localDir: path.join('/test/path', 'dir1'),
        }),
      );
    });

    it('filters by bucket name if option is provided', async () => {
      options.options.bucket = 'target-bucket';
      const rawBuckets: RawBucketConfig[] = [
        { bucketName: 'other-bucket', localDir: 'dir1' },
        { bucketName: 'target-bucket', localDir: 'dir2' },
      ];

      await orchestrator.sync(rawBuckets);

      expect(s3Ops.uploadDirectory).toHaveBeenCalledTimes(1);
      expect(s3Ops.uploadDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: 'target-bucket',
        }),
      );
    });

    it('runs preCommand if defined', async () => {
      const rawBuckets: RawBucketConfig[] = [
        {
          bucketName: 'bucket-1',
          localDir: 'dir1',
          preCommand: 'npm run build',
        },
      ];

      await orchestrator.sync(rawBuckets);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'npm run build',
        expect.objectContaining({
          cwd: '/test/path',
        }),
      );
    });

    it('throws and logs error if preCommand fails', async () => {
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error('exec failed');
      });

      const rawBuckets: RawBucketConfig[] = [
        { bucketName: 'bucket-1', localDir: 'dir1', preCommand: 'fail' },
      ];

      await expect(orchestrator.sync(rawBuckets)).rejects.toThrow(
        'exec failed',
      );
      expect(options.log.error).toHaveBeenCalledWith(
        expect.stringContaining('Pre-command failed'),
      );
    });

    it('logs success when invoked as command', async () => {
      await orchestrator.sync([{ bucketName: 'b', localDir: 'd' }], true);
      expect(options.log.success).toHaveBeenCalledWith(
        expect.stringContaining('Synced files'),
      );
    });
  });

  describe('clear()', () => {
    it('executes deleteDirectory for enabled buckets', async () => {
      const rawBuckets: RawBucketConfig[] = [
        { bucketName: 'bucket-1', localDir: 'dir1' },
      ];

      await orchestrator.clear(rawBuckets);

      expect(s3Ops.deleteDirectory).toHaveBeenCalledTimes(1);
      expect(s3Ops.deleteDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: 'bucket-1',
        }),
      );
    });
  });

  describe('syncMetadata()', () => {
    it('executes syncDirectoryMetadata for buckets with params', async () => {
      const rawBuckets: RawBucketConfig[] = [
        {
          bucketName: 'bucket-1',
          localDir: 'dir1',
          params: [{ '*': { ACL: 'public-read' } }],
        },
        { bucketName: 'bucket-2', localDir: 'dir2' }, // no params, should skip
      ];

      await orchestrator.syncMetadata(rawBuckets);

      expect(s3Ops.syncDirectoryMetadata).toHaveBeenCalledTimes(1);
      expect(s3Ops.syncDirectoryMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: 'bucket-1',
        }),
      );
    });
  });

  describe('syncBucketTags()', () => {
    it('executes updateBucketTags for buckets with tags', async () => {
      const rawBuckets: RawBucketConfig[] = [
        {
          bucketName: 'bucket-1',
          localDir: 'dir1',
          bucketTags: { Key1: 'Value1' },
        },
        { bucketName: 'bucket-2', localDir: 'dir2' }, // no tags, should skip
      ];

      await orchestrator.syncBucketTags(rawBuckets);

      expect(s3Ops.updateBucketTags).toHaveBeenCalledTimes(1);
      expect(s3Ops.updateBucketTags).toHaveBeenCalledWith(
        mockS3Client,
        'bucket-1',
        [{ Key: 'Key1', Value: 'Value1' }],
      );
    });
  });
});
