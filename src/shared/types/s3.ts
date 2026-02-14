import type { ObjectCannedACL } from '@aws-sdk/client-s3';

export type S3Params = Record<string, string>;

export interface FileUploadEntry {
  localPath: string;
  s3Key: string;
  s3Params: S3Params;
}

export interface S3Object {
  Key: string;
  ETag?: string;
  Size?: number;
}

export interface UploadDirOptions {
  localDir: string;
  bucket: string;
  prefix: string;
  acl: ObjectCannedACL;
  deleteRemoved: boolean;
  defaultContentType?: string;
  params?: ParamMatcher[];
  maxConcurrency?: number;
}

export interface ParamMatcher {
  glob: string;
  params: S3Params;
}

export interface FileToSync {
  name: string;
  params: S3Params;
}

export interface Tag {
  Key: string;
  Value: string;
}
