import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetBucketTaggingCommand,
  ListObjectsV2Command,
  PutBucketTaggingCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  AwsProviderExtended,
  Plugin,
  RawBucketConfig,
  RawS3FerryConfig,
  S3FerryOptions,
  Serverless,
} from '@shared';
import {
  mockAwsIam,
  mockProgress,
  mockProvider,
  TEST_BUCKET,
  TEST_STACK_NAME,
} from '@shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/aws/iam', () => mockAwsIam());

// @ts-expect-error CJS module.exports is resolved at runtime by vitest
import ServerlessS3Ferry from './index';

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

function mockServerless(
  config: RawS3FerryConfig | RawBucketConfig[],
  servicePath: string,
): Serverless {
  return {
    service: {
      serverless: { config: { servicePath } },
      custom: { s3Ferry: config },
    },
    getProvider: () => mockProvider() as unknown as AwsProviderExtended,
  } as unknown as Serverless;
}

describe('ServerlessS3Ferry', () => {
  const s3Mock = mockClient(S3Client);
  const cfnMock = mockClient(CloudFormationClient);
  let tmpDir: string;

  beforeEach(() => {
    s3Mock.reset();
    cfnMock.reset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3ferry-test-'));
  });

  afterEach(() => {
    s3Mock.restore();
    cfnMock.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('registers default hooks', () => {
      const plugin = new ServerlessS3Ferry(
        mockServerless([{ bucketName: TEST_BUCKET, localDir: '.' }], tmpDir),
        {} as S3FerryOptions,
        mockLogging(),
      );

      const expectedHooks = [
        'after:deploy:deploy',
        'before:remove:remove',
        's3ferry:sync',
        's3ferry:metadata',
        's3ferry:tags',
        's3ferry:bucket:sync',
        's3ferry:bucket:metadata',
        's3ferry:bucket:tags',
        'before:offline:start',
        'before:offline:start:init',
        'after:offline:start:init',
        'after:offline:start',
      ];

      for (const hook of expectedHooks) {
        expect(plugin.hooks[hook]).toBeTypeOf('function');
      }
    });

    it('registers custom hooks', () => {
      const config: RawS3FerryConfig = {
        buckets: [{ bucketName: TEST_BUCKET, localDir: '.' }],
        hooks: ['after:deploy:finalize'],
      };

      const plugin = new ServerlessS3Ferry(
        mockServerless(config, tmpDir),
        {} as S3FerryOptions,
        mockLogging(),
      );

      expect(plugin.hooks['after:deploy:finalize']).toBeTypeOf('function');
    });

    it('registers commands', () => {
      const plugin = new ServerlessS3Ferry(
        mockServerless([{ bucketName: TEST_BUCKET, localDir: '.' }], tmpDir),
        {} as S3FerryOptions,
        mockLogging(),
      );

      expect(plugin.commands.s3ferry).toBeDefined();
      expect(plugin.commands.deploy?.options?.nos3ferry).toBeDefined();
      expect(plugin.commands.remove?.options?.nos3ferry).toBeDefined();
    });
  });

  describe('sync()', () => {
    it('uploads files to S3', async () => {
      fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>hello</h1>');

      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false }],
          tmpDir,
        ),
        {} as S3FerryOptions,
        mockLogging(),
      );

      await plugin.sync();

      const putCalls = s3Mock.commandCalls(PutObjectCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Bucket).toBe(TEST_BUCKET);
      expect(putCalls[0].args[0].input.Key).toBe('index.html');
    });

    it('logs error when config is missing', async () => {
      const logging = mockLogging();

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          { buckets: undefined } as unknown as RawS3FerryConfig,
          tmpDir,
        ),
        {} as S3FerryOptions,
        logging,
      );

      await plugin.sync();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('at least one configuration entry'),
      );
    });

    it('skips disabled bucket', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', enabled: false }],
          tmpDir,
        ),
        {} as S3FerryOptions,
        mockLogging(),
      );

      await plugin.sync();

      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });

    it('filters by --bucket option', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');

      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [
            { bucketName: 'bucket-a', localDir: '.', deleteRemoved: false },
            { bucketName: 'bucket-b', localDir: '.', deleteRemoved: false },
          ],
          tmpDir,
        ),
        { bucket: 'bucket-a' } as S3FerryOptions,
        mockLogging(),
      );

      await plugin.sync();

      const putCalls = s3Mock.commandCalls(PutObjectCommand);
      for (const call of putCalls) {
        expect(call.args[0].input.Bucket).toBe('bucket-a');
      }
    });

    it('resolves bucketNameKey via CloudFormation', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');

      cfnMock.on(DescribeStacksCommand).resolves({
        Stacks: [
          {
            Outputs: [
              { OutputKey: 'MyOutput', OutputValue: 'resolved-bucket' },
            ],
            StackName: TEST_STACK_NAME,
            StackStatus: 'CREATE_COMPLETE',
            CreationTime: new Date(),
          },
        ],
      });
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketNameKey: 'MyOutput', localDir: '.', deleteRemoved: false }],
          tmpDir,
        ),
        {} as S3FerryOptions,
        mockLogging(),
      );

      await plugin.sync();

      const putCalls = s3Mock.commandCalls(PutObjectCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Bucket).toBe('resolved-bucket');
    });

    it('executes preCommand before upload', async () => {
      const execSyncSpy = vi
        .spyOn(child_process, 'execSync')
        .mockReturnValue(Buffer.from(''));

      try {
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');

        s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
        s3Mock.on(PutObjectCommand).resolves({});

        const plugin = new ServerlessS3Ferry(
          mockServerless(
            [
              {
                bucketName: TEST_BUCKET,
                localDir: '.',
                deleteRemoved: false,
                preCommand: 'echo test',
              },
            ],
            tmpDir,
          ),
          {} as S3FerryOptions,
          mockLogging(),
        );

        await plugin.sync();

        expect(execSyncSpy).toHaveBeenCalledWith('echo test', {
          stdio: 'inherit',
          timeout: 120_000,
        });
      } finally {
        execSyncSpy.mockRestore();
      }
    });

    it('nos3ferry skips sync via hook', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false }],
          tmpDir,
        ),
        { nos3ferry: true } as S3FerryOptions,
        mockLogging(),
      );

      await plugin.hooks['after:deploy:deploy']();

      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });

    it('deletes remote files when deleteRemoved is true', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: 'old.txt', ETag: '"abc"' }],
      });
      s3Mock.on(DeleteObjectsCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: true }],
          tmpDir,
        ),
        {} as S3FerryOptions,
        mockLogging(),
      );

      await plugin.sync();

      const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].args[0].input.Delete?.Objects).toEqual([
        { Key: 'old.txt' },
      ]);
    });
  });

  describe('clear()', () => {
    it('deletes all objects from bucket', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: 'a.txt' }, { Key: 'b.txt' }],
      });
      s3Mock.on(DeleteObjectsCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless([{ bucketName: TEST_BUCKET, localDir: '.' }], tmpDir),
        {} as S3FerryOptions,
        mockLogging(),
      );

      await plugin.clear();

      const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].args[0].input.Delete?.Objects).toEqual([
        { Key: 'a.txt' },
        { Key: 'b.txt' },
      ]);
    });

    it('skips when config is missing', async () => {
      const logging = mockLogging();

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          { buckets: undefined } as unknown as RawS3FerryConfig,
          tmpDir,
        ),
        {} as S3FerryOptions,
        logging,
      );

      await plugin.clear();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log.notice).toHaveBeenCalledWith(
        expect.stringContaining('No configuration found'),
      );
    });

    it('skips disabled bucket', async () => {
      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', enabled: false }],
          tmpDir,
        ),
        {} as S3FerryOptions,
        mockLogging(),
      );

      await plugin.clear();

      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });
  });

  describe('syncMetadata()', () => {
    it('copies objects with metadata params', async () => {
      fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>hello</h1>');

      s3Mock.on(CopyObjectCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [
            {
              bucketName: TEST_BUCKET,
              localDir: '.',
              params: [{ '*.html': { CacheControl: 'max-age=300' } }],
            },
          ],
          tmpDir,
        ),
        {} as S3FerryOptions,
        mockLogging(),
      );

      await plugin.syncMetadata();

      const copyCalls = s3Mock.commandCalls(CopyObjectCommand);
      expect(copyCalls).toHaveLength(1);
      expect(copyCalls[0].args[0].input.CacheControl).toBe('max-age=300');
    });

    it('ignores files with mismatched OnlyForEnv', async () => {
      fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>hello</h1>');

      s3Mock.on(CopyObjectCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [
            {
              bucketName: TEST_BUCKET,
              localDir: '.',
              params: [
                {
                  '*.html': { CacheControl: 'max-age=300', OnlyForEnv: 'prod' },
                },
              ],
            },
          ],
          tmpDir,
        ),
        { env: 'dev' } as S3FerryOptions,
        mockLogging(),
      );

      await plugin.syncMetadata();

      expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(0);
    });

    it('logs error when config is missing', async () => {
      const logging = mockLogging();

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          { buckets: undefined } as unknown as RawS3FerryConfig,
          tmpDir,
        ),
        {} as S3FerryOptions,
        logging,
      );

      await plugin.syncMetadata();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('at least one configuration entry'),
      );
    });

    it('filters by --bucket option', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.css'), 'body{}');

      s3Mock.on(CopyObjectCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [
            {
              bucketName: 'bucket-a',
              localDir: '.',
              params: [{ '*.css': { CacheControl: 'max-age=600' } }],
            },
            {
              bucketName: 'bucket-b',
              localDir: '.',
              params: [{ '*.css': { CacheControl: 'max-age=600' } }],
            },
          ],
          tmpDir,
        ),
        { bucket: 'bucket-a' } as S3FerryOptions,
        mockLogging(),
      );

      await plugin.syncMetadata();

      const copyCalls = s3Mock.commandCalls(CopyObjectCommand);
      expect(copyCalls.length).toBeGreaterThan(0);
      for (const call of copyCalls) {
        expect(call.args[0].input.Bucket).toBe('bucket-a');
      }
    });
  });

  describe('syncBucketTags()', () => {
    it('updates bucket tags', async () => {
      s3Mock.on(GetBucketTaggingCommand).resolves({
        TagSet: [{ Key: 'existing', Value: 'val' }],
      });
      s3Mock.on(PutBucketTaggingCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [
            {
              bucketName: TEST_BUCKET,
              localDir: '.',
              bucketTags: { env: 'prod' },
            },
          ],
          tmpDir,
        ),
        {} as S3FerryOptions,
        mockLogging(),
      );

      await plugin.syncBucketTags();

      const putCalls = s3Mock.commandCalls(PutBucketTaggingCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Tagging?.TagSet).toEqual([
        { Key: 'existing', Value: 'val' },
        { Key: 'env', Value: 'prod' },
      ]);
    });

    it('logs error when config is missing', async () => {
      const logging = mockLogging();

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          { buckets: undefined } as unknown as RawS3FerryConfig,
          tmpDir,
        ),
        {} as S3FerryOptions,
        logging,
      );

      await plugin.syncBucketTags();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('at least one configuration entry'),
      );
    });

    it('skips bucket without tags', async () => {
      const plugin = new ServerlessS3Ferry(
        mockServerless([{ bucketName: TEST_BUCKET, localDir: '.' }], tmpDir),
        {} as S3FerryOptions,
        mockLogging(),
      );

      await plugin.syncBucketTags();

      expect(s3Mock.commandCalls(GetBucketTaggingCommand)).toHaveLength(0);
    });

    it('filters by --bucket option', async () => {
      s3Mock.on(GetBucketTaggingCommand).resolves({ TagSet: [] });
      s3Mock.on(PutBucketTaggingCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [
            {
              bucketName: 'bucket-a',
              localDir: '.',
              bucketTags: { env: 'prod' },
            },
            {
              bucketName: 'bucket-b',
              localDir: '.',
              bucketTags: { env: 'staging' },
            },
          ],
          tmpDir,
        ),
        { bucket: 'bucket-a' } as S3FerryOptions,
        mockLogging(),
      );

      await plugin.syncBucketTags();

      const putCalls = s3Mock.commandCalls(PutBucketTaggingCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Bucket).toBe('bucket-a');
    });
  });

  describe('offline', () => {
    it('sync works when IS_OFFLINE env var is set', async () => {
      const original = process.env.IS_OFFLINE;
      process.env.IS_OFFLINE = 'true';

      try {
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');

        s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
        s3Mock.on(PutObjectCommand).resolves({});

        const plugin = new ServerlessS3Ferry(
          mockServerless(
            [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false }],
            tmpDir,
          ),
          {} as S3FerryOptions,
          mockLogging(),
        );

        await plugin.sync();

        const putCalls = s3Mock.commandCalls(PutObjectCommand);
        expect(putCalls).toHaveLength(1);
      } finally {
        if (original === undefined) {
          delete process.env.IS_OFFLINE;
        } else {
          process.env.IS_OFFLINE = original;
        }
      }
    });
  });
});
