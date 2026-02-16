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

export function getNoSync(
  rawConfig: RawS3FerryConfig | RawBucketConfig[],
  optionNoSync?: boolean,
): boolean {
  if (optionNoSync) {
    return true;
  }
  if (Array.isArray(rawConfig)) {
    return false;
  }
  const noSync = rawConfig.noSync ?? false;
  return String(noSync).toUpperCase() === 'TRUE';
}

export function getEndpoint(
  rawConfig: RawS3FerryConfig | RawBucketConfig[],
): string | null {
  if (Array.isArray(rawConfig)) {
    return null;
  }
  return (rawConfig.endpoint as string) ?? null;
}

export function getCustomHooks(
  rawConfig: RawS3FerryConfig | RawBucketConfig[],
): string[] {
  if (Array.isArray(rawConfig)) {
    return [];
  }
  return (rawConfig.hooks as string[]) ?? [];
}
