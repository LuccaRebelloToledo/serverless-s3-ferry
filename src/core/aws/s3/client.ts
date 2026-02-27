import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getAwsOptions } from '@core/aws/iam';
import {
  AWS_MAX_ATTEMPTS_DEFAULT,
  AWS_RETRY_MODE_ADAPTIVE,
  type AwsProviderExtended,
} from '@shared';

export interface CreateS3ClientOptions {
  provider: AwsProviderExtended;
  endpoint?: string | null;
  offline?: boolean;
}

/**
 * Creates an S3 client with adaptive retry strategy and global configuration.
 */
export function createS3Client(options: CreateS3ClientOptions): S3Client {
  const awsOptions = getAwsOptions(options.provider);

  const config: S3ClientConfig = {
    region: awsOptions.region,
    credentials: awsOptions.credentials,
    // Adaptive retry mode handles throttling and network issues intelligently.
    retryMode: AWS_RETRY_MODE_ADAPTIVE,
    maxAttempts: AWS_MAX_ATTEMPTS_DEFAULT,
  };

  if (options.endpoint && options.offline) {
    config.endpoint = options.endpoint;
    config.forcePathStyle = true;
  }

  return new S3Client(config);
}
