import { ObjectCannedACL } from '@aws-sdk/client-s3';
import {
  type BucketSyncConfig,
  ConfigValidationError,
  MAX_PART_SIZE,
  MIN_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS,
  MIN_PART_SIZE,
  MIN_QUEUE_SIZE,
  type ParamEntry,
  type ParamMatcher,
  type RawBucketConfig,
  type RawS3FerryConfig,
  type S3Params,
  TRUE_STRING,
} from '@shared';

export function getBucketConfigs(
  rawConfig: RawS3FerryConfig | RawBucketConfig[],
): RawBucketConfig[] | null {
  if (Array.isArray(rawConfig)) {
    return rawConfig;
  }
  if (rawConfig.buckets && Array.isArray(rawConfig.buckets)) {
    return rawConfig.buckets;
  }
  return null;
}

export function parseBucketConfig(raw: RawBucketConfig): BucketSyncConfig {
  if ((!raw.bucketName && !raw.bucketNameKey) || !raw.localDir) {
    throw new ConfigValidationError(
      'Invalid custom.s3Ferry: each bucket entry must have (bucketName or bucketNameKey) and localDir',
    );
  }

  if (raw.partSize != null) {
    if (!Number.isInteger(raw.partSize)) {
      throw new ConfigValidationError(
        'Invalid custom.s3Ferry: partSize must be an integer',
      );
    }
    if (raw.partSize < MIN_PART_SIZE) {
      throw new ConfigValidationError(
        `Invalid custom.s3Ferry: partSize must be at least ${MIN_PART_SIZE} bytes (5 MiB)`,
      );
    }
    if (raw.partSize > MAX_PART_SIZE) {
      throw new ConfigValidationError(
        `Invalid custom.s3Ferry: partSize must not exceed ${MAX_PART_SIZE} bytes (5 GiB)`,
      );
    }
  }

  if (raw.queueSize != null) {
    if (!Number.isInteger(raw.queueSize)) {
      throw new ConfigValidationError(
        'Invalid custom.s3Ferry: queueSize must be an integer',
      );
    }
    if (raw.queueSize < MIN_QUEUE_SIZE) {
      throw new ConfigValidationError(
        `Invalid custom.s3Ferry: queueSize must be at least ${MIN_QUEUE_SIZE}`,
      );
    }
  }

  if (raw.multipartThreshold != null) {
    if (!Number.isInteger(raw.multipartThreshold)) {
      throw new ConfigValidationError(
        'Invalid custom.s3Ferry: multipartThreshold must be an integer',
      );
    }
    if (raw.multipartThreshold < 0) {
      throw new ConfigValidationError(
        'Invalid custom.s3Ferry: multipartThreshold must not be negative',
      );
    }
  }

  if (
    raw.abortIncompleteMultipartUploadDays != null &&
    raw.abortIncompleteMultipartUploadDays !== false
  ) {
    if (!Number.isInteger(raw.abortIncompleteMultipartUploadDays)) {
      throw new ConfigValidationError(
        'Invalid custom.s3Ferry: abortIncompleteMultipartUploadDays must be an integer or false to disable',
      );
    }
    if (
      raw.abortIncompleteMultipartUploadDays <
      MIN_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS
    ) {
      throw new ConfigValidationError(
        `Invalid custom.s3Ferry: abortIncompleteMultipartUploadDays must be at least ${MIN_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS} or false to disable`,
      );
    }
  }

  return {
    bucketName: raw.bucketName,
    bucketNameKey: raw.bucketNameKey,
    localDir: raw.localDir,
    bucketPrefix: raw.bucketPrefix ?? '',
    acl: raw.acl ?? ObjectCannedACL.private,
    enabled: raw.enabled ?? true,
    deleteRemoved: raw.deleteRemoved ?? true,
    defaultContentType: raw.defaultContentType,
    preCommand: raw.preCommand,
    params: raw.params ?? [],
    bucketTags: raw.bucketTags,
    multipartThreshold: raw.multipartThreshold,
    partSize: raw.partSize,
    queueSize: raw.queueSize,
    abortIncompleteMultipartUploadDays: raw.abortIncompleteMultipartUploadDays,
  };
}

export function extractMetaParams(config: ParamEntry): S3Params {
  const validParams: S3Params = {};
  for (const key of Object.keys(config)) {
    Object.assign(validParams, config[key]);
  }
  return validParams;
}

export function buildParamMatchers(params: ParamEntry[]): ParamMatcher[] {
  return params
    .map((param) => {
      const glob = Object.keys(param)[0];
      if (!glob) return null;
      return {
        glob,
        params: extractMetaParams(param),
      };
    })
    .filter((matcher): matcher is ParamMatcher => !!matcher);
}

interface GetNoSyncOptions {
  rawConfig: RawS3FerryConfig | RawBucketConfig[];
  optionNoSync?: boolean;
}

export function getNoSync(options: GetNoSyncOptions): boolean {
  const { rawConfig, optionNoSync } = options;
  if (optionNoSync) {
    return true;
  }
  if (Array.isArray(rawConfig)) {
    return false;
  }
  const noSync = rawConfig.noSync ?? false;
  return String(noSync).toUpperCase() === TRUE_STRING;
}

export function getEndpoint(
  rawConfig: RawS3FerryConfig | RawBucketConfig[],
): string | null {
  if (Array.isArray(rawConfig)) {
    return null;
  }
  return typeof rawConfig.endpoint === 'string' ? rawConfig.endpoint : null;
}

export function getCustomHooks(
  rawConfig: RawS3FerryConfig | RawBucketConfig[],
): string[] {
  if (Array.isArray(rawConfig)) {
    return [];
  }
  return Array.isArray(rawConfig.hooks) ? rawConfig.hooks : [];
}
