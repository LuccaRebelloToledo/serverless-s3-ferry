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
  getLocalFiles,
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

interface ResolvedBucket {
  config: BucketSyncConfig;
  bucketName: string;
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
    const resolvedBuckets = await this.resolveBuckets();
    if (!resolvedBuckets) {
      this.log.error(
        'serverless-s3-ferry requires at least one configuration entry in custom.s3Ferry',
      );
      return;
    }

    const localFilesCache = new Map<string, string[]>();
    await this.sync(undefined, resolvedBuckets, localFilesCache);
    await this.syncMetadata(undefined, resolvedBuckets, localFilesCache);
    await this.syncBucketTags(undefined, resolvedBuckets);
  }

  async sync(
    invokedAsCommand?: boolean,
    preResolved?: ResolvedBucket[],
    localFilesCache?: Map<string, string[]>,
  ): Promise<void> {
    return this.forEachBucket({
      taskMessage: this.bucket
        ? `Syncing directory attached to S3 bucket ${this.bucket}`
        : 'Syncing directories to S3 buckets',
      preResolved,
      invokedAsCommand,
      successMessage: 'Synced files to S3 buckets',
      process: async ({ config, bucketName }) => {
        if (!config.enabled) return;
        if (this.bucket && bucketName !== this.bucket) return;

        const localDir = path.join(this.servicePath, config.localDir);
        const localFiles = this.getCachedLocalFiles({
          localDir,
          cache: localFilesCache,
        });

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

          // Apply lifecycle rule before upload so incomplete multipart uploads
          // are cleaned up even if the upload fails partway through
          const abortDays =
            config.abortIncompleteMultipartUploadDays ??
            DEFAULT_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS;

          if (abortDays !== false) {
            await ensureAbortIncompleteMultipartUploadRule({
              s3Client: this.getS3Client(),
              bucket: bucketName,
              prefix: config.bucketPrefix,
              daysAfterInitiation: abortDays,
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
            localFiles,
          });
        } finally {
          bucketProgress.remove();
        }
      },
    });
  }

  async clear(): Promise<void> {
    return this.forEachBucket({
      taskMessage: 'Removing objects from S3 buckets',
      nullLog: (msg) => this.log.notice(msg),
      nullMessage:
        'No configuration found for serverless-s3-ferry, skipping removal...',
      successMessage: 'Removed objects from S3 buckets',
      process: async ({ config, bucketName }) => {
        if (!config.enabled) return;

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
      },
    });
  }

  async syncMetadata(
    invokedAsCommand?: boolean,
    preResolved?: ResolvedBucket[],
    localFilesCache?: Map<string, string[]>,
  ): Promise<void> {
    return this.forEachBucket({
      taskMessage: 'Syncing bucket metadata',
      preResolved,
      invokedAsCommand,
      successMessage: 'Synced bucket metadata',
      process: async ({ config, bucketName }) => {
        if (config.params.length === 0) return;
        if (this.bucket && bucketName !== this.bucket) return;

        const localDir = path.join(this.servicePath, config.localDir);
        const localFiles = this.getCachedLocalFiles({
          localDir,
          cache: localFilesCache,
        });

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
            localFiles,
          });
        } finally {
          bucketProgress.remove();
        }
      },
    });
  }

  async syncBucketTags(
    invokedAsCommand?: boolean,
    preResolved?: ResolvedBucket[],
  ): Promise<void> {
    return this.forEachBucket({
      taskMessage: 'Updating bucket tags',
      preResolved,
      invokedAsCommand,
      successMessage: 'Updated bucket tags',
      process: async ({ config, bucketName }) => {
        if (!config.bucketTags) return;
        if (this.bucket && bucketName !== this.bucket) return;

        const tagsToUpdate: Tag[] = Object.keys(config.bucketTags)
          .map((tagKey) => ({
            Key: tagKey,
            Value: config.bucketTags?.[tagKey],
          }))
          .filter((tag): tag is Tag => !!tag.Value);

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
      },
    });
  }

  private async forEachBucket(options: {
    taskMessage: string;
    nullMessage?: string;
    nullLog?: (message: string) => void;
    preResolved?: ResolvedBucket[];
    process: (resolved: ResolvedBucket) => Promise<void>;
    invokedAsCommand?: boolean;
    successMessage: string;
  }): Promise<void> {
    const {
      taskMessage,
      nullMessage = 'serverless-s3-ferry requires at least one configuration entry in custom.s3Ferry',
      nullLog = (msg: string) => this.log.error(msg),
      preResolved,
      process,
      invokedAsCommand,
      successMessage,
    } = options;

    const resolvedBuckets = preResolved ?? (await this.resolveBuckets());
    if (!resolvedBuckets) {
      nullLog(nullMessage);
      return;
    }

    const taskProgress = this.progress.create({ message: taskMessage });

    try {
      await Promise.all(resolvedBuckets.map(process));

      if (invokedAsCommand) {
        this.log.success(successMessage);
      } else {
        this.log.verbose(successMessage);
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

  private async getBucketName(config: BucketSyncConfig): Promise<string> {
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

  private async resolveBuckets(): Promise<ResolvedBucket[] | null> {
    const rawBuckets = getBucketConfigs(this.rawConfig);
    if (!rawBuckets) return null;

    return Promise.all(
      rawBuckets.map(async (raw) => {
        const config = parseBucketConfig(raw);
        const bucketName = await this.getBucketName(config);
        return { config, bucketName };
      }),
    );
  }

  private getCachedLocalFiles(options: {
    localDir: string;
    cache?: Map<string, string[]>;
  }): string[] {
    const { localDir, cache } = options;
    if (cache) {
      let files = cache.get(localDir);
      if (!files) {
        files = getLocalFiles({ dir: localDir, log: this.log });
        cache.set(localDir, files);
      }
      return files;
    }
    return getLocalFiles({ dir: localDir, log: this.log });
  }
}
