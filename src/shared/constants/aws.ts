export const DEFAULT_REGION = 'us-east-1';
export const DEFAULT_MAX_CONCURRENCY = 5;
export const S3_DELETE_BATCH_SIZE = 1000;

// S3 Limits and Defaults
export const S3_MAX_SIMPLE_COPY_SIZE = 5 * 1024 * 1024 * 1024; // 5GB
export const S3_MULTIPART_COPY_PART_SIZE = 500 * 1024 * 1024; // 500MB
export const S3_MULTIPART_UPLOAD_PART_SIZE = 5 * 1024 * 1024; // 5MB
export const S3_MULTIPART_UPLOAD_QUEUE_SIZE = 4;
export const S3_COPY_METADATA_DIRECTIVE = 'REPLACE';

// SDK Configurations
export const AWS_RETRY_MODE_ADAPTIVE = 'adaptive';
export const AWS_MAX_ATTEMPTS_DEFAULT = 5;
