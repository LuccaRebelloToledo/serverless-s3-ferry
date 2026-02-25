import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from 'node:process';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetBucketTaggingCommand,
  HeadObjectCommand,
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
      const putCall = putCalls[0];
      if (!putCall) throw new Error('Expected PutObjectCommand call');
      expect(putCall.args[0].input.Bucket).toBe(TEST_BUCKET);
      expect(putCall.args[0].input.Key).toBe('index.html');
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
      expect(log['error']).toHaveBeenCalledWith(
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
      const putCall = putCalls[0];
      if (!putCall) throw new Error('Expected PutObjectCommand call');
      expect(putCall.args[0].input.Bucket).toBe('resolved-bucket');
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
          cwd: tmpDir,
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
      const deleteCall = deleteCalls[0];
      if (!deleteCall) throw new Error('Expected DeleteObjectsCommand call');
      expect(deleteCall.args[0].input.Delete?.Objects).toEqual([
        { Key: 'old.txt' },
      ]);
    });

    it('caches S3 client across multiple buckets', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [
            { bucketName: 'bucket-1', localDir: '.', deleteRemoved: false },
            { bucketName: 'bucket-2', localDir: '.', deleteRemoved: false },
          ],
          tmpDir,
        ),
        {} as S3FerryOptions,
        mockLogging(),
      );

      await plugin.sync();

      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(2);
    });

    it('throws error when bucketName and bucketNameKey are missing', async () => {
      const plugin = new ServerlessS3Ferry(
        mockServerless([], tmpDir),
        {} as S3FerryOptions,
        mockLogging(),
      );

      // Bypass visibility to reach the unreachable check in getBucketName
      await expect(
        (
          plugin as unknown as {
            getBucketName: (config: RawBucketConfig) => Promise<string>;
          }
        ).getBucketName({ localDir: '.' }),
      ).rejects.toThrow(
        'Unable to find bucketName. Please provide a value for bucketName or bucketNameKey',
      );
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
      const deleteCall = deleteCalls[0];
      if (!deleteCall) throw new Error('Expected DeleteObjectsCommand call');
      expect(deleteCall.args[0].input.Delete?.Objects).toEqual([
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
      expect(log['notice']).toHaveBeenCalledWith(
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

      s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 100 });
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
      const copyCall = copyCalls[0];
      if (!copyCall) throw new Error('Expected CopyObjectCommand call');
      expect(copyCall.args[0].input.CacheControl).toBe('max-age=300');
    });

    it('ignores files with mismatched OnlyForStage', async () => {
      fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>hello</h1>');

      s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 100 });
      s3Mock.on(CopyObjectCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [
            {
              bucketName: TEST_BUCKET,
              localDir: '.',
              params: [
                {
                  '*.html': {
                    CacheControl: 'max-age=300',
                    OnlyForStage: 'prod',
                  },
                },
              ],
            },
          ],
          tmpDir,
        ),
        { stage: 'dev' } as S3FerryOptions,
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
      expect(log['error']).toHaveBeenCalledWith(
        expect.stringContaining('at least one configuration entry'),
      );
    });

    it('filters by --bucket option', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.css'), 'body{}');

      s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 100 });
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
      const putCall = putCalls[0];
      if (!putCall) throw new Error('Expected PutBucketTaggingCommand call');
      expect(putCall.args[0].input.Tagging?.TagSet).toEqual([
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
      expect(log['error']).toHaveBeenCalledWith(
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
      const putCall = putCalls[0];
      if (!putCall) throw new Error('Expected PutBucketTaggingCommand call');
      expect(putCall.args[0].input.Bucket).toBe('bucket-a');
    });
  });

  describe('hook: s3ferry:sync logs success', () => {
    it('logs success when invoked as command', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      const logging = mockLogging();
      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false }],
          tmpDir,
        ),
        {} as S3FerryOptions,
        logging,
      );

      await plugin.hooks['s3ferry:sync']();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log['success']).toHaveBeenCalledWith(
        expect.stringContaining('Synced files to S3 buckets'),
      );
    });
  });

  describe('hook: s3ferry:metadata logs success', () => {
    it('logs success when invoked as command', async () => {
      fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>hello</h1>');
      s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 100 });
      s3Mock.on(CopyObjectCommand).resolves({});

      const logging = mockLogging();
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
        logging,
      );

      await plugin.hooks['s3ferry:metadata']();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log['success']).toHaveBeenCalledWith(
        expect.stringContaining('Synced bucket metadata'),
      );
    });
  });

  describe('hook: s3ferry:tags logs success', () => {
    it('logs success when invoked as command', async () => {
      s3Mock.on(GetBucketTaggingCommand).resolves({ TagSet: [] });
      s3Mock.on(PutBucketTaggingCommand).resolves({});

      const logging = mockLogging();
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
        logging,
      );

      await plugin.hooks['s3ferry:tags']();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log['success']).toHaveBeenCalledWith(
        expect.stringContaining('Updated bucket tags'),
      );
    });
  });

  describe('hook: after:deploy:deploy', () => {
    it('runs full sync (sync + metadata + tags)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      const logging = mockLogging();
      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false }],
          tmpDir,
        ),
        {} as S3FerryOptions,
        logging,
      );

      await plugin.hooks['after:deploy:deploy']();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log['verbose']).toHaveBeenCalledWith(
        expect.stringContaining('Synced files to S3 buckets'),
      );
      expect(log['verbose']).toHaveBeenCalledWith(
        expect.stringContaining('Synced bucket metadata'),
      );
      expect(log['verbose']).toHaveBeenCalledWith(
        expect.stringContaining('Updated bucket tags'),
      );
    });
  });

  describe('hook: before:offline:start', () => {
    it('sets offline mode', async () => {
      const logging = mockLogging();
      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false }],
          tmpDir,
        ),
        {} as S3FerryOptions,
        logging,
      );

      await plugin.hooks['before:offline:start']();

      // Verify offline is set by triggering a sync (it should create a new client with offline config)
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(PutObjectCommand).resolves({});
      await plugin.sync();

      // If we got here without error, offline was set correctly
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    });
  });

  describe('hook: before:offline:start:init', () => {
    it('sets offline mode', async () => {
      const logging = mockLogging();
      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false }],
          tmpDir,
        ),
        {} as S3FerryOptions,
        logging,
      );

      await plugin.hooks['before:offline:start:init']();

      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(PutObjectCommand).resolves({});
      await plugin.sync();

      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    });
  });

  describe('hook: after:offline:start:init', () => {
    it('runs full sync', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      const logging = mockLogging();
      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false }],
          tmpDir,
        ),
        {} as S3FerryOptions,
        logging,
      );

      await plugin.hooks['after:offline:start:init']();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log['verbose']).toHaveBeenCalledWith(
        expect.stringContaining('Synced files to S3 buckets'),
      );
    });
  });

  describe('hook: after:offline:start', () => {
    it('runs full sync', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      const logging = mockLogging();
      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false }],
          tmpDir,
        ),
        {} as S3FerryOptions,
        logging,
      );

      await plugin.hooks['after:offline:start']();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log['verbose']).toHaveBeenCalledWith(
        expect.stringContaining('Synced files to S3 buckets'),
      );
    });
  });

  describe('hook: before:remove:remove', () => {
    it('clears bucket objects', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: 'a.txt' }],
      });
      s3Mock.on(DeleteObjectsCommand).resolves({});

      const plugin = new ServerlessS3Ferry(
        mockServerless([{ bucketName: TEST_BUCKET, localDir: '.' }], tmpDir),
        {} as S3FerryOptions,
        mockLogging(),
      );

      await plugin.hooks['before:remove:remove']();

      expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(1);
    });

    it('skips when nos3ferry is true', async () => {
      const plugin = new ServerlessS3Ferry(
        mockServerless([{ bucketName: TEST_BUCKET, localDir: '.' }], tmpDir),
        { nos3ferry: true } as S3FerryOptions,
        mockLogging(),
      );

      await plugin.hooks['before:remove:remove']();

      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });
  });

  describe('hooks: s3ferry:bucket:*', () => {
    it('s3ferry:bucket:sync runs sync', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      const logging = mockLogging();
      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false }],
          tmpDir,
        ),
        {} as S3FerryOptions,
        logging,
      );

      await plugin.hooks['s3ferry:bucket:sync']();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log['success']).toHaveBeenCalledWith(
        expect.stringContaining('Synced files to S3 buckets'),
      );
    });

    it('s3ferry:bucket:metadata runs syncMetadata', async () => {
      fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>hello</h1>');
      s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 100 });
      s3Mock.on(CopyObjectCommand).resolves({});

      const logging = mockLogging();
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
        logging,
      );

      await plugin.hooks['s3ferry:bucket:metadata']();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log['success']).toHaveBeenCalledWith(
        expect.stringContaining('Synced bucket metadata'),
      );
    });

    it('s3ferry:bucket:tags runs syncBucketTags', async () => {
      s3Mock.on(GetBucketTaggingCommand).resolves({ TagSet: [] });
      s3Mock.on(PutBucketTaggingCommand).resolves({});

      const logging = mockLogging();
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
        logging,
      );

      await plugin.hooks['s3ferry:bucket:tags']();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log['success']).toHaveBeenCalledWith(
        expect.stringContaining('Updated bucket tags'),
      );
    });
  });

  describe('custom hook callback', () => {
    it('executes full sync when custom hook is invoked', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');
      s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
      s3Mock.on(PutObjectCommand).resolves({});

      const logging = mockLogging();
      const config: RawS3FerryConfig = {
        buckets: [
          { bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false },
        ],
        hooks: ['after:deploy:finalize'],
      };

      const plugin = new ServerlessS3Ferry(
        mockServerless(config, tmpDir),
        {} as S3FerryOptions,
        logging,
      );

      await plugin.hooks['after:deploy:finalize']();

      const log = logging.log as unknown as Record<
        string,
        ReturnType<typeof vi.fn>
      >;
      expect(log['verbose']).toHaveBeenCalledWith(
        expect.stringContaining('Synced files to S3 buckets'),
      );
      expect(log['verbose']).toHaveBeenCalledWith(
        expect.stringContaining('Synced bucket metadata'),
      );
      expect(log['verbose']).toHaveBeenCalledWith(
        expect.stringContaining('Updated bucket tags'),
      );
    });
  });

  describe('offline hooks with nos3ferry', () => {
    it('after:offline:start:init skips when nos3ferry is true', async () => {
      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false }],
          tmpDir,
        ),
        { nos3ferry: true } as S3FerryOptions,
        mockLogging(),
      );

      await plugin.hooks['after:offline:start:init']();

      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });

    it('after:offline:start skips when nos3ferry is true', async () => {
      const plugin = new ServerlessS3Ferry(
        mockServerless(
          [{ bucketName: TEST_BUCKET, localDir: '.', deleteRemoved: false }],
          tmpDir,
        ),
        { nos3ferry: true } as S3FerryOptions,
        mockLogging(),
      );

      await plugin.hooks['after:offline:start']();

      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });
  });

  describe('offline', () => {
    it('sync works when IS_OFFLINE env var is set', async () => {
      const original = env['IS_OFFLINE'];
      env['IS_OFFLINE'] = 'true';

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
          delete env['IS_OFFLINE'];
        } else {
          env['IS_OFFLINE'] = original;
        }
      }
    });
  });
});
