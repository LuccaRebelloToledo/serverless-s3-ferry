import child_process from 'node:child_process';
import path from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  type BucketSyncConfig,
  buildParamMatchers,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PRE_COMMAND_TIMEOUT,
  type Plugin,
  parseBucketConfig,
  type RawBucketConfig,
  type S3FerryOptions,
  type Tag,
} from '@shared';
import {
  deleteDirectory,
  syncDirectoryMetadata,
  updateBucketTags,
  uploadDirectory,
} from './aws/s3';

/**
 * Options for the SyncOrchestrator.
 */
export interface SyncOrchestratorOptions {
  s3Client: S3Client;
  servicePath: string;
  options: S3FerryOptions;
  log: Plugin.Logging['log'];
  progress: Plugin.Logging['progress'];
  /**
   * Resolver function to get the actual bucket name (e.g. from CloudFormation).
   */
  getBucketName: (
    config: BucketSyncConfig | RawBucketConfig,
  ) => Promise<string>;
}

interface ExecuteOptions {
  rawBuckets: RawBucketConfig[];
  taskMessage: string;
  successMessage: string;
  operation: (
    config: BucketSyncConfig,
    bucketName: string,
    bucketProgress: Plugin.Progress,
  ) => Promise<void>;
  invokedAsCommand?: boolean;
}

/**
 * Orchestrates S3 sync operations across multiple bucket configurations.
 * Handles progress tracking, pre-commands, and filtering.
 */
export class SyncOrchestrator {
  constructor(private readonly options: SyncOrchestratorOptions) {}

  /**
   * Executes a pre-command defined in the bucket configuration.
   */
  private runPreCommand(
    command: string,
    bucketProgress: Plugin.Progress,
  ): void {
    this.options.log.verbose(`Running pre-command: ${command}`);
    bucketProgress.update(`running pre-command...`);

    try {
      child_process.execSync(command, {
        stdio: 'inherit',
        timeout: DEFAULT_PRE_COMMAND_TIMEOUT,
        cwd: this.options.servicePath,
      });
    } catch (error) {
      this.options.log.error(`Pre-command failed: ${command}`);
      throw error;
    }
  }

  /**
   * Common execution logic for all sync operations.
   */
  private async execute(options: ExecuteOptions): Promise<void> {
    const {
      rawBuckets,
      taskMessage,
      successMessage,
      operation,
      invokedAsCommand,
    } = options;

    const taskProgress = this.options.progress.create({
      message: this.options.options.bucket
        ? `${taskMessage} (filtering by bucket: ${this.options.options.bucket})`
        : taskMessage,
    });

    try {
      const promises = rawBuckets.map(async (raw) => {
        const config = parseBucketConfig(raw);
        if (!config.enabled) return;

        const bucketName = await this.options.getBucketName(config);
        if (
          this.options.options.bucket &&
          bucketName !== this.options.options.bucket
        ) {
          return;
        }

        const bucketProgress = this.options.progress.create({
          message: `${bucketName}: preparing...`,
        });

        try {
          if (config.preCommand) {
            this.runPreCommand(config.preCommand, bucketProgress);
          }

          await operation(config, bucketName, bucketProgress);
        } finally {
          bucketProgress.remove();
        }
      });

      await Promise.all(promises);

      if (invokedAsCommand) {
        this.options.log.success(successMessage);
      } else {
        this.options.log.verbose(successMessage);
      }
    } finally {
      taskProgress.remove();
    }
  }

  /**
   * Syncs directories to S3 buckets.
   */
  async sync(
    rawBuckets: RawBucketConfig[],
    invokedAsCommand?: boolean,
  ): Promise<void> {
    await this.execute({
      rawBuckets,
      taskMessage: 'Syncing directories to S3 buckets',
      successMessage: 'Synced files to S3 buckets',
      operation: async (config, bucketName, bucketProgress) => {
        const localDir = path.join(this.options.servicePath, config.localDir);
        const paramMatchers = buildParamMatchers(config.params);

        await uploadDirectory({
          s3Client: this.options.s3Client,
          localDir,
          bucket: bucketName,
          prefix: config.bucketPrefix,
          acl: config.acl,
          deleteRemoved: config.deleteRemoved,
          defaultContentType: config.defaultContentType,
          params: paramMatchers,
          maxConcurrency: DEFAULT_MAX_CONCURRENCY,
          progress: bucketProgress,
          servicePath: this.options.servicePath,
          stage: this.options.options.stage,
          log: this.options.log,
        });
      },
      invokedAsCommand,
    });
  }

  /**
   * Removes objects from S3 buckets based on configuration.
   */
  async clear(rawBuckets: RawBucketConfig[]): Promise<void> {
    await this.execute({
      rawBuckets,
      taskMessage: 'Removing objects from S3 buckets',
      successMessage: 'Removed objects from S3 buckets',
      operation: async (config, bucketName, bucketProgress) => {
        await deleteDirectory({
          s3Client: this.options.s3Client,
          bucket: bucketName,
          prefix: config.bucketPrefix,
          progress: bucketProgress,
        });
      },
      invokedAsCommand: false,
    });
  }

  /**
   * Syncs metadata for existing S3 objects.
   */
  async syncMetadata(
    rawBuckets: RawBucketConfig[],
    invokedAsCommand?: boolean,
  ): Promise<void> {
    await this.execute({
      rawBuckets,
      taskMessage: 'Syncing bucket metadata',
      successMessage: 'Synced bucket metadata',
      operation: async (config, bucketName, bucketProgress) => {
        if (config.params.length === 0) return;
        const localDir = path.join(this.options.servicePath, config.localDir);

        await syncDirectoryMetadata({
          s3Client: this.options.s3Client,
          localDir,
          bucket: bucketName,
          bucketPrefix: config.bucketPrefix,
          acl: config.acl,
          defaultContentType: config.defaultContentType,
          params: config.params,
          stage: this.options.options.stage,
          progress: bucketProgress,
          log: this.options.log,
        });
      },
      invokedAsCommand,
    });
  }

  /**
   * Updates S3 bucket tags.
   */
  async syncBucketTags(
    rawBuckets: RawBucketConfig[],
    invokedAsCommand?: boolean,
  ): Promise<void> {
    await this.execute({
      rawBuckets,
      taskMessage: 'Updating bucket tags',
      successMessage: 'Updated bucket tags',
      operation: async (config, bucketName, bucketProgress) => {
        if (!config.bucketTags) return;

        bucketProgress.update('sync bucket tags');

        const tagsToUpdate: Tag[] = Object.keys(config.bucketTags)
          .map((tagKey) => ({
            Key: tagKey,
            Value: config.bucketTags?.[tagKey],
          }))
          .filter((tag): tag is Tag => !!tag.Value);

        await updateBucketTags(this.options.s3Client, bucketName, tagsToUpdate);
      },
      invokedAsCommand,
    });
  }
}
