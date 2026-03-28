import { S3FerryCore } from '@core/s3-ferry-core';
import {
  type AwsProviderExtended,
  getCustomHooks,
  getNoSync,
  PLUGIN_KEY,
  type Plugin,
  PROVIDER_NAME,
  type RawBucketConfig,
  type RawS3FerryConfig,
  type S3FerryOptions,
  type Serverless,
  TRUE_STRING,
} from '@shared';

class ServerlessS3Ferry implements Plugin {
  private readonly core: S3FerryCore;

  public commands: Plugin.Commands;
  public hooks: Plugin.Hooks;

  constructor(
    serverless: Serverless,
    options: S3FerryOptions,
    logging: Plugin.Logging,
  ) {
    const rawConfig = serverless.service.custom[PLUGIN_KEY] as
      | RawS3FerryConfig
      | RawBucketConfig[];
    const servicePath = serverless.service.serverless.config.servicePath;
    const offline = String(options.offline).toUpperCase() === TRUE_STRING;

    this.core = new S3FerryCore({
      provider: serverless.getProvider(PROVIDER_NAME) as AwsProviderExtended,
      rawConfig,
      servicePath,
      log: logging.log,
      progress: logging.progress,
      bucket: options.bucket,
      stage: options.stage,
      offline,
    });

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

    const noSync = getNoSync({
      rawConfig,
      optionNoSync: options.nos3ferry,
    });
    const customHooks = getCustomHooks(rawConfig);
    const customHookEntries = Object.fromEntries(
      customHooks.map((hook) => [hook, () => this.core.performFullSync()]),
    );

    this.hooks = {
      'after:deploy:deploy': async () => {
        if (noSync) return;
        await this.core.performFullSync();
      },
      'after:offline:start:init': async () => {
        if (noSync) return;
        await this.core.performFullSync();
      },
      'after:offline:start': async () => {
        if (noSync) return;
        await this.core.performFullSync();
      },
      'before:offline:start': async () => {
        this.core.setOffline();
      },
      'before:offline:start:init': async () => {
        this.core.setOffline();
      },
      'before:remove:remove': async () => {
        if (noSync) return;
        await this.core.clear();
      },
      's3ferry:sync': async () => {
        await this.core.sync(true);
      },
      's3ferry:metadata': async () => {
        await this.core.syncMetadata(true);
      },
      's3ferry:tags': async () => {
        await this.core.syncBucketTags(true);
      },
      's3ferry:bucket:sync': async () => {
        await this.core.sync(true);
      },
      's3ferry:bucket:metadata': async () => {
        await this.core.syncMetadata(true);
      },
      's3ferry:bucket:tags': async () => {
        await this.core.syncBucketTags(true);
      },
      ...customHookEntries,
    };
  }

  async sync(invokedAsCommand?: boolean): Promise<void> {
    return this.core.sync(invokedAsCommand);
  }

  async clear(): Promise<void> {
    return this.core.clear();
  }

  async syncMetadata(invokedAsCommand?: boolean): Promise<void> {
    return this.core.syncMetadata(invokedAsCommand);
  }

  async syncBucketTags(invokedAsCommand?: boolean): Promise<void> {
    return this.core.syncBucketTags(invokedAsCommand);
  }
}

module.exports = ServerlessS3Ferry;
