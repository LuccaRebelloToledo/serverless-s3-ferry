import type { ObjectCannedACL } from '@aws-sdk/client-s3';
import type { S3Params } from './s3';

export interface RawS3FerryConfig {
  buckets?: RawBucketConfig[];
  endpoint?: string;
  noSync?: boolean | string;
  hooks?: string[];
  [key: string]: unknown;
}

export interface ParamEntry {
  [glob: string]: S3Params;
}

export interface BucketSyncConfig {
  bucketName?: string;
  bucketNameKey?: string;
  localDir: string;
  bucketPrefix: string;
  acl: ObjectCannedACL;
  enabled: boolean;
  deleteRemoved: boolean;
  defaultContentType?: string;
  preCommand?: string;
  params: ParamEntry[];
  bucketTags?: S3Params;
}

export interface RawBucketConfig extends Partial<BucketSyncConfig> {
  [key: string]: unknown;
}
