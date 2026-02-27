import { env } from 'node:process';
import type { S3Client } from '@aws-sdk/client-s3';
import { resolveStackOutput } from '@core/aws/cloudformation';
import { createS3Client } from '@core/aws/s3';
import { SyncOrchestrator } from '@core/sync-orchestrator';
import {
  type AwsProviderExtended,
  type BucketSyncConfig,
  ConfigValidationError,
  DEFAULT_OFFLINE_VALUE,
  getBucketConfigs,
  getCustomHooks,
  getEndpoint,
  getNoSync,
  OFFLINE_ENV_VAR,
  type Plugin,
  type RawBucketConfig,
  type RawS3FerryConfig,
  type S3FerryOptions,
  type Serverless,
} from '@shared';

/**
 * ServerlessS3Ferry Plugin
 *
 * A Serverless Framework plugin for syncing local directories to S3 buckets.
 */
class ServerlessS3Ferry implements Plugin {
  private readonly serverless: Serverless;
  private readonly options: S3FerryOptions;
  private readonly log: Plugin.Logging['log'];
  private readonly progress: Plugin.Logging['progress'];
  private readonly servicePath: string;
  private offline: boolean;
  private _s3Client: S3Client | null = null;
  private _orchestrator: SyncOrchestrator | null = null;

  public commands: Plugin.Commands;
  public hooks: Plugin.Hooks;

  constructor(
    serverless: Serverless,
    options: S3FerryOptions,
    logging: Plugin.Logging,
  ) {
    this.serverless = serverless;
    this.options = options;
    this.log = logging.log;
    this.progress = logging.progress;
    this.servicePath = this.serverless.service.serverless.config.servicePath;
    this.offline =
      String(this.options.offline).toUpperCase() === DEFAULT_OFFLINE_VALUE;

    this.commands = this.defineCommands();
    this.hooks = this.defineHooks();
  }

  /**
   * Defines the plugin commands.
   */
  private defineCommands(): Plugin.Commands {
    return {
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
  }

  /**
   * Defines the plugin hooks.
   */
  private defineHooks(): Plugin.Hooks {
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

    return {
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
    this._orchestrator = null;
  }

  private isOffline(): boolean {
    return this.offline || !!env[OFFLINE_ENV_VAR];
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

  private getS3Client(): S3Client {
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

  private getOrchestrator(): SyncOrchestrator {
    if (!this._orchestrator) {
      this._orchestrator = new SyncOrchestrator({
        s3Client: this.getS3Client(),
        servicePath: this.servicePath,
        options: this.options,
        log: this.log,
        progress: this.progress,
        getBucketName: this.getBucketName.bind(this),
      });
    }
    return this._orchestrator;
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

    await this.getOrchestrator().sync(rawBuckets, invokedAsCommand);
  }

  async clear(): Promise<void> {
    const rawBuckets = this.getRawBucketConfigs();
    if (!rawBuckets) {
      this.log.notice(
        'No configuration found for serverless-s3-ferry, skipping removal...',
      );
      return;
    }

    await this.getOrchestrator().clear(rawBuckets);
  }

  async syncMetadata(invokedAsCommand?: boolean): Promise<void> {
    const rawBuckets = this.getRawBucketConfigs();
    if (!rawBuckets) {
      this.log.error(
        'serverless-s3-ferry requires at least one configuration entry in custom.s3Ferry',
      );
      return;
    }

    await this.getOrchestrator().syncMetadata(rawBuckets, invokedAsCommand);
  }

  async syncBucketTags(invokedAsCommand?: boolean): Promise<void> {
    const rawBuckets = this.getRawBucketConfigs();
    if (!rawBuckets) {
      this.log.error(
        'serverless-s3-ferry requires at least one configuration entry in custom.s3Ferry',
      );
      return;
    }

    await this.getOrchestrator().syncBucketTags(rawBuckets, invokedAsCommand);
  }
}

module.exports = ServerlessS3Ferry;
