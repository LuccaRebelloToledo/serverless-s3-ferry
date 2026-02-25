import child_process from 'node:child_process';
import path from 'node:path';
import { env } from 'node:process';
import type { S3Client } from '@aws-sdk/client-s3';
import { resolveStackOutput } from '@core/aws/cloudformation';
import {
  createS3Client,
  deleteDirectory,
  syncDirectoryMetadata,
  updateBucketTags,
  uploadDirectory,
} from '@core/aws/s3';
import {
  type AwsProviderExtended,
  type BucketSyncConfig,
  buildParamMatchers,
  ConfigValidationError,
  DEFAULT_MAX_CONCURRENCY,
  getBucketConfigs,
  getCustomHooks,
  getEndpoint,
  getNoSync,
  type Plugin,
  parseBucketConfig,
  type RawBucketConfig,
  type RawS3FerryConfig,
  type S3FerryOptions,
  type Serverless,
  type Tag,
} from '@shared';

class ServerlessS3Ferry implements Plugin {
  private readonly serverless: Serverless;
  private readonly options: S3FerryOptions;
  private readonly log: Plugin.Logging['log'];
  private readonly progress: Plugin.Logging['progress'];
  private readonly servicePath: string;
  private offline: boolean;
  private _s3Client: S3Client | null = null;

  public commands: Plugin.Commands;
  public hooks: Plugin.Hooks;

  constructor(
    serverless: Serverless,
    options: S3FerryOptions,
    logging: Plugin.Logging,
  ) {
    this.serverless = serverless;
    this.options = options || {};
    this.log = logging.log;
    this.progress = logging.progress;
    this.servicePath = this.serverless.service.serverless.config.servicePath;
    this.offline = String(this.options.offline).toUpperCase() === 'TRUE';

    this.commands = {
      s3ferry: {
        usage: 'Sync directories and S3 prefixes',
        lifecycleEvents: ['sync', 'metadata', 'tags'],
        commands: {
          bucket: {
            options: {
              bucket: {
                usage:
                  'Specify the bucket you want to deploy (e.g. "-b myBucket1")',
                required: true,
                shortcut: 'b',
                type: 'string',
              },
            },
            lifecycleEvents: ['sync', 'metadata', 'tags'],
          },
        },
      },
      deploy: {
        options: {
          nos3ferry: {
            type: 'boolean',
            usage: 'Disable sync to S3 during deploy',
          },
        },
      },
      remove: {
        options: {
          nos3ferry: {
            type: 'boolean',
            usage: 'Disable sync to S3 during remove',
          },
        },
      },
      offline: {
        options: {
          nos3ferry: {
            type: 'boolean',
            usage: 'Disable sync to S3 for serverless offline',
          },
        },
        commands: {
          start: {
            options: {
              nos3ferry: {
                type: 'boolean',
                usage:
                  'Disable sync to S3 for serverless offline start command',
              },
            },
          },
        },
      },
    };

    const noSync = this.shouldSkipSync();
    const customHooks = getCustomHooks(this.getS3FerryConfig());
    const customHookEntries = customHooks.reduce(
      (acc: Record<string, () => Promise<void>>, hook: string) => {
        acc[hook] = async () => {
          await this.performFullSync();
        };
        return acc;
      },
      {},
    );

    this.hooks = {
      'after:deploy:deploy': async () => {
        if (noSync) return;
        await this.performFullSync();
      },
      'after:offline:start:init': async () => {
        if (noSync) return;
        await this.performFullSync();
      },
      'after:offline:start': async () => {
        if (noSync) return;
        await this.performFullSync();
      },
      'before:offline:start': async () => {
        this.setOffline();
      },
      'before:offline:start:init': async () => {
        this.setOffline();
      },
      'before:remove:remove': async () => {
        if (noSync) return;
        await this.clear();
      },
      's3ferry:sync': async () => {
        await this.sync(true);
      },
      's3ferry:metadata': async () => {
        await this.syncMetadata(true);
      },
      's3ferry:tags': async () => {
        await this.syncBucketTags(true);
      },
      's3ferry:bucket:sync': async () => {
        await this.sync(true);
      },
      's3ferry:bucket:metadata': async () => {
        await this.syncMetadata(true);
      },
      's3ferry:bucket:tags': async () => {
        await this.syncBucketTags(true);
      },
      ...customHookEntries,
    };
  }

  private async performFullSync(): Promise<void> {
    await this.sync();
    await this.syncMetadata();
    await this.syncBucketTags();
  }

  private setOffline(): void {
    this.offline = true;
    this._s3Client = null;
  }

  private isOffline(): boolean {
    return this.offline || !!env['IS_OFFLINE'];
  }

  private getProvider(): AwsProviderExtended {
    return this.serverless.getProvider('aws') as AwsProviderExtended;
  }

  private getS3FerryConfig(): RawS3FerryConfig | RawBucketConfig[] {
    return this.serverless.service.custom['s3Ferry'] as
      | RawS3FerryConfig
      | RawBucketConfig[];
  }

  private shouldSkipSync(): boolean {
    return getNoSync(this.getS3FerryConfig(), this.options.nos3ferry);
  }

  private getS3Client() {
    if (!this._s3Client) {
      const endpoint = getEndpoint(this.getS3FerryConfig());
      const provider = this.getProvider();
      this._s3Client = createS3Client({
        provider,
        endpoint,
        offline: this.isOffline(),
      });
    }
    return this._s3Client;
  }

  private async getBucketName(
    config: BucketSyncConfig | RawBucketConfig,
  ): Promise<string> {
    if (config.bucketName) {
      return config.bucketName;
    }
    if (config.bucketNameKey) {
      const provider = this.getProvider();
      return resolveStackOutput(provider, config.bucketNameKey);
    }
    throw new ConfigValidationError(
      'Unable to find bucketName. Please provide a value for bucketName or bucketNameKey',
    );
  }

  private getRawBucketConfigs(): RawBucketConfig[] | null {
    return getBucketConfigs(this.getS3FerryConfig());
  }

  async sync(invokedAsCommand?: boolean): Promise<void> {
    const rawBuckets = this.getRawBucketConfigs();
    if (!rawBuckets) {
      this.log.error(
        'serverless-s3-ferry requires at least one configuration entry in custom.s3Ferry',
      );
      return;
    }

    const taskProgress = this.progress.create({
      message: this.options.bucket
        ? `Syncing directory attached to S3 bucket ${this.options.bucket}`
        : 'Syncing directories to S3 buckets',
    });

    try {
      const promises = rawBuckets.map(async (raw) => {
        const config = parseBucketConfig(raw);
        if (!config.enabled) return;

        const bucketName = await this.getBucketName(config);
        if (this.options.bucket && bucketName !== this.options.bucket) {
          return;
        }

        const localDir = path.join(this.servicePath, config.localDir);

        const bucketProgress = this.progress.create({
          message: `${localDir}: sync with bucket ${bucketName} (0%)`,
        });

        try {
          if (config.preCommand) {
            bucketProgress.update(`${localDir}: running pre-command...`);
            child_process.execSync(config.preCommand, {
              stdio: 'inherit',
              timeout: 120_000,
            });
          }

          const paramMatchers = buildParamMatchers(config.params);

          await uploadDirectory({
            s3Client: this.getS3Client(),
            localDir,
            bucket: bucketName,
            prefix: config.bucketPrefix,
            acl: config.acl,
            deleteRemoved: config.deleteRemoved,
            defaultContentType: config.defaultContentType,
            params: paramMatchers,
            maxConcurrency: DEFAULT_MAX_CONCURRENCY,
            progress: bucketProgress,
            servicePath: this.servicePath,
            stage: this.options.stage,
            log: this.log,
          });
        } finally {
          bucketProgress.remove();
        }
      });

      await Promise.all(promises);

      if (invokedAsCommand) {
        this.log.success('Synced files to S3 buckets');
      } else {
        this.log.verbose('Synced files to S3 buckets');
      }
    } finally {
      taskProgress.remove();
    }
  }

  async clear(): Promise<void> {
    const rawBuckets = this.getRawBucketConfigs();
    if (!rawBuckets) {
      this.log.notice(
        'No configuration found for serverless-s3-ferry, skipping removal...',
      );
      return;
    }

    const taskProgress = this.progress.create({
      message: 'Removing objects from S3 buckets',
    });

    try {
      const promises = rawBuckets.map(async (raw) => {
        const config = parseBucketConfig(raw);
        if (!config.enabled) return;

        const bucketName = await this.getBucketName(config);

        const bucketProgress = this.progress.create({
          message: `${bucketName}: removing files with prefix ${config.bucketPrefix} (0%)`,
        });

        try {
          await deleteDirectory({
            s3Client: this.getS3Client(),
            bucket: bucketName,
            prefix: config.bucketPrefix,
            progress: bucketProgress,
          });
        } finally {
          bucketProgress.remove();
        }
      });

      await Promise.all(promises);
      this.log.verbose('Removed objects from S3 buckets');
    } finally {
      taskProgress.remove();
    }
  }

  async syncMetadata(invokedAsCommand?: boolean): Promise<void> {
    const rawBuckets = this.getRawBucketConfigs();
    if (!rawBuckets) {
      this.log.error(
        'serverless-s3-ferry requires at least one configuration entry in custom.s3Ferry',
      );
      return;
    }

    const taskProgress = this.progress.create({
      message: 'Syncing bucket metadata',
    });

    try {
      const promises = rawBuckets.map(async (raw) => {
        const config = parseBucketConfig(raw);

        if (config.params.length === 0) return;

        const bucketName = await this.getBucketName(config);
        if (this.options?.bucket && bucketName !== this.options.bucket) {
          return;
        }

        const localDir = path.join(this.servicePath, config.localDir);

        const bucketProgress = this.progress.create({
          message: `${localDir}: sync bucket metadata to ${bucketName} (0%)`,
        });

        try {
          await syncDirectoryMetadata({
            s3Client: this.getS3Client(),
            localDir,
            bucket: bucketName,
            bucketPrefix: config.bucketPrefix,
            acl: config.acl,
            defaultContentType: config.defaultContentType,
            params: config.params,
            stage: this.options.stage,
            progress: bucketProgress,
            log: this.log,
          });
        } finally {
          bucketProgress.remove();
        }
      });

      await Promise.all(promises);

      if (invokedAsCommand) {
        this.log.success('Synced bucket metadata');
      } else {
        this.log.verbose('Synced bucket metadata');
      }
    } finally {
      taskProgress.remove();
    }
  }

  async syncBucketTags(invokedAsCommand?: boolean): Promise<void> {
    const rawBuckets = this.getRawBucketConfigs();
    if (!rawBuckets) {
      this.log.error(
        'serverless-s3-ferry requires at least one configuration entry in custom.s3Ferry',
      );
      return;
    }

    const taskProgress = this.progress.create({
      message: 'Updating bucket tags',
    });

    try {
      const promises = rawBuckets.map(async (raw) => {
        const config = parseBucketConfig(raw);

        if (!config.bucketTags) {
          return;
        }

        const tagsToUpdate: Tag[] = Object.keys(config.bucketTags)
          .map((tagKey) => ({
            Key: tagKey,
            Value: config.bucketTags?.[tagKey],
          }))
          .filter((tag): tag is Tag => !!tag.Value);

        const bucketName = await this.getBucketName(config);
        if (this.options?.bucket && bucketName !== this.options.bucket) {
          return;
        }

        const bucketProgress = this.progress.create({
          message: `${bucketName}: sync bucket tags`,
        });

        try {
          await updateBucketTags(this.getS3Client(), bucketName, tagsToUpdate);
        } finally {
          bucketProgress.remove();
        }
      });

      await Promise.all(promises);

      if (invokedAsCommand) {
        this.log.success('Updated bucket tags');
      } else {
        this.log.verbose('Updated bucket tags');
      }
    } finally {
      taskProgress.remove();
    }
  }
}

module.exports = ServerlessS3Ferry;
