import { ObjectCannedACL } from '@aws-sdk/client-s3';
import {
  type BucketSyncConfig,
  ConfigValidationError,
  type ParamEntry,
  type ParamMatcher,
  type RawBucketConfig,
  type RawS3FerryConfig,
  type S3Params,
} from '@shared';

/**
 * Resolves the list of bucket configurations from the raw plugin configuration.
 * Supports both array-style and object-style configurations.
 */
export function getBucketConfigs(
  rawConfig?: RawS3FerryConfig | RawBucketConfig[],
): RawBucketConfig[] | null {
  if (!rawConfig) {
    return null;
  }
  if (Array.isArray(rawConfig)) {
    return rawConfig;
  }
  if (rawConfig.buckets && Array.isArray(rawConfig.buckets)) {
    return rawConfig.buckets;
  }
  return null;
}

/**
 * Validates and normalizes a single bucket configuration entry.
 * @throws {ConfigValidationError} If required fields are missing.
 */
export function parseBucketConfig(raw: RawBucketConfig): BucketSyncConfig {
  if ((!raw.bucketName && !raw.bucketNameKey) || !raw.localDir) {
    throw new ConfigValidationError(
      'Invalid custom.s3Ferry: each bucket entry must have (bucketName or bucketNameKey) and localDir',
    );
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
  };
}

/**
 * Extracts S3 parameters from a configuration entry.
 */
export function extractMetaParams(config: ParamEntry): S3Params {
  const validParams: S3Params = {};
  for (const key of Object.keys(config)) {
    Object.assign(validParams, config[key]);
  }
  return validParams;
}

/**
 * Transforms raw parameter entries into a list of glob matchers.
 */
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

/**
 * Checks if auto-sync should be skipped based on configuration or CLI options.
 */
export function getNoSync(
  rawConfig?: RawS3FerryConfig | RawBucketConfig[],
  optionNoSync?: boolean,
): boolean {
  if (optionNoSync) {
    return true;
  }
  if (!rawConfig) {
    return false;
  }
  if (Array.isArray(rawConfig)) {
    return false;
  }
  const noSync = rawConfig.noSync ?? false;
  return String(noSync).toUpperCase() === 'TRUE';
}

/**
 * Retrieves the custom S3 endpoint from the configuration, if any.
 */
export function getEndpoint(
  rawConfig?: RawS3FerryConfig | RawBucketConfig[],
): string | null {
  if (!rawConfig || Array.isArray(rawConfig)) {
    return null;
  }
  return (rawConfig.endpoint as string) ?? null;
}

/**
 * Retrieves the list of custom lifecycle hooks from the configuration.
 */
export function getCustomHooks(
  rawConfig?: RawS3FerryConfig | RawBucketConfig[],
): string[] {
  if (!rawConfig || Array.isArray(rawConfig)) {
    return [];
  }
  return (rawConfig.hooks as string[]) ?? [];
}
