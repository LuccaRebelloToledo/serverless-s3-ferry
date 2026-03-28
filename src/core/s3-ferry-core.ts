import child_process from 'node:child_process';
import path from 'node:path';
import { env } from 'node:process';
import type { S3Client } from '@aws-sdk/client-s3';
import { resolveStackOutput } from '@core/aws/cloudformation';
import {
  createS3Client,
  deleteDirectory,
  ensureAbortIncompleteMultipartUploadRule,
  syncDirectoryMetadata,
  updateBucketTags,
  uploadDirectory,
} from '@core/aws/s3';
import {
  type AwsProviderExtended,
  type BucketSyncConfig,
  buildParamMatchers,
  ConfigValidationError,
  DEFAULT_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS,
  DEFAULT_MAX_CONCURRENCY,
  getBucketConfigs,
  getEndpoint,
  IS_OFFLINE_ENV,
  type Plugin,
  PRE_COMMAND_TIMEOUT,
  parseBucketConfig,
  type RawBucketConfig,
  type RawS3FerryConfig,
  type Tag,
} from '@shared';

export interface S3FerryCoreOptions {
  provider: AwsProviderExtended;
  rawConfig: RawS3FerryConfig | RawBucketConfig[];
  servicePath: string;
  log: Plugin.Logging['log'];
  progress: Plugin.Logging['progress'];
  bucket?: string;
  stage?: string;
  offline?: boolean;
}

export class S3FerryCore {
  private readonly provider: AwsProviderExtended;
  private readonly rawConfig: RawS3FerryConfig | RawBucketConfig[];
  private readonly servicePath: string;
  private readonly log: Plugin.Logging['log'];
  private readonly progress: Plugin.Logging['progress'];
  private readonly bucket?: string;
  private readonly stage?: string;
  private offline: boolean;
  private _s3Client: S3Client | null = null;

  constructor(options: S3FerryCoreOptions) {
    this.provider = options.provider;
    this.rawConfig = options.rawConfig;
    this.servicePath = options.servicePath;
    this.log = options.log;
    this.progress = options.progress;
    this.bucket = options.bucket;
    this.stage = options.stage;
    this.offline = options.offline ?? false;
  }

  setOffline(): void {
    this.offline = true;
    this._s3Client = null;
  }

  async performFullSync(): Promise<void> {
    await this.sync();
    await this.syncMetadata();
    await this.syncBucketTags();
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
      message: this.bucket
        ? `Syncing directory attached to S3 bucket ${this.bucket}`
        : 'Syncing directories to S3 buckets',
    });

    try {
      const promises = rawBuckets.map(async (raw) => {
        const config = parseBucketConfig(raw);
        if (!config.enabled) return;

        const bucketName = await this.getBucketName(config);
        if (this.bucket && bucketName !== this.bucket) {
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
              timeout: PRE_COMMAND_TIMEOUT,
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
            multipartThreshold: config.multipartThreshold,
            partSize: config.partSize,
            queueSize: config.queueSize,
            progress: bucketProgress,
            servicePath: this.servicePath,
            stage: this.stage,
            log: this.log,
          });

          const abortDays =
            config.abortIncompleteMultipartUploadDays ??
            DEFAULT_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS;

          if (abortDays !== false) {
            await ensureAbortIncompleteMultipartUploadRule({
              s3Client: this.getS3Client(),
              bucket: bucketName,
              daysAfterInitiation: abortDays,
            });
          }
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
        if (this.bucket && bucketName !== this.bucket) {
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
            stage: this.stage,
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
        if (this.bucket && bucketName !== this.bucket) {
          return;
        }

        const bucketProgress = this.progress.create({
          message: `${bucketName}: sync bucket tags`,
        });

        try {
          await updateBucketTags({
            s3Client: this.getS3Client(),
            bucket: bucketName,
            tagsToUpdate,
          });
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

  private isOffline(): boolean {
    return this.offline || !!env[IS_OFFLINE_ENV];
  }

  private getS3Client(): S3Client {
    if (!this._s3Client) {
      const endpoint = getEndpoint(this.rawConfig);
      this._s3Client = createS3Client({
        provider: this.provider,
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
      return resolveStackOutput({
        provider: this.provider,
        outputKey: config.bucketNameKey,
      });
    }

    throw new ConfigValidationError(
      'Unable to find bucketName. Please provide a value for bucketName or bucketNameKey',
    );
  }

  private getRawBucketConfigs(): RawBucketConfig[] | null {
    return getBucketConfigs(this.rawConfig);
  }
}
