export const DEFAULT_REGION = 'us-east-1';
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
export const DEFAULT_MAX_CONCURRENCY = 5;

// S3 Defaults
export const S3_METADATA_DIRECTIVE_REPLACE = 'REPLACE';
export const S3_NO_SUCH_TAG_SET = 'NoSuchTagSet';
export const S3_DELETE_BATCH_SIZE = 1000;

// Multipart Upload Defaults (aligned with AWS best practices)
export const DEFAULT_MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB
export const DEFAULT_PART_SIZE = 16 * 1024 * 1024; // 16MB (recommended 16-64MB)
export const DEFAULT_QUEUE_SIZE = 4; // concurrent part uploads per file (total = maxConcurrency * queueSize = 20)
export const S3_CONTENT_MD5_METADATA_KEY = 'content-md5';

// Lifecycle Rule Defaults
export const DEFAULT_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS = 7;
export const S3_FERRY_LIFECYCLE_RULE_ID = 's3-ferry-abort-incomplete-multipart';
export const S3_NO_SUCH_LIFECYCLE_CONFIGURATION =
  'NoSuchLifecycleConfiguration';

// AWS SDK Configurations
export const AWS_RETRY_MODE_ADAPTIVE = 'adaptive';
export const AWS_MAX_ATTEMPTS_DEFAULT = 5;

// AWS S3 Multipart Upload Limits
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
export const MIN_PART_SIZE = 5 * 1024 * 1024; // 5 MiB
export const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB
export const MAX_PARTS_PER_UPLOAD = 10_000;
export const MAX_OBJECT_SIZE = MAX_PARTS_PER_UPLOAD * MAX_PART_SIZE; // ~48.8 TiB
export const MIN_QUEUE_SIZE = 1;
export const MIN_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS = 1;
