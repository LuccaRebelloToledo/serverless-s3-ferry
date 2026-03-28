import {
  type BucketLifecycleConfiguration,
  GetBucketLifecycleConfigurationCommand,
  type LifecycleRule,
  PutBucketLifecycleConfigurationCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  S3_FERRY_LIFECYCLE_RULE_ID,
  S3_NO_SUCH_LIFECYCLE_CONFIGURATION,
} from '@shared';

interface EnsureAbortIncompleteMultipartUploadRuleOptions {
  s3Client: S3Client;
  bucket: string;
  prefix?: string;
  daysAfterInitiation: number;
}

export async function ensureAbortIncompleteMultipartUploadRule(
  options: EnsureAbortIncompleteMultipartUploadRuleOptions,
): Promise<void> {
  const { s3Client, bucket, prefix = '', daysAfterInitiation } = options;

  let existingRules: LifecycleRule[] = [];

  try {
    const data = await s3Client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    );
    existingRules = data.Rules ?? [];
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === S3_NO_SUCH_LIFECYCLE_CONFIGURATION
    ) {
      existingRules = [];
    } else {
      throw err;
    }
  }

  const existingRuleIndex = existingRules.findIndex(
    (rule) => rule.ID === S3_FERRY_LIFECYCLE_RULE_ID,
  );

  const abortRule: LifecycleRule = {
    ID: S3_FERRY_LIFECYCLE_RULE_ID,
    Status: 'Enabled',
    Filter: { Prefix: prefix },
    AbortIncompleteMultipartUpload: {
      DaysAfterInitiation: daysAfterInitiation,
    },
  };

  if (existingRuleIndex >= 0) {
    existingRules[existingRuleIndex] = abortRule;
  } else {
    existingRules.push(abortRule);
  }

  const lifecycleConfig: BucketLifecycleConfiguration = {
    Rules: existingRules,
  };

  await s3Client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: lifecycleConfig,
    }),
  );
}
