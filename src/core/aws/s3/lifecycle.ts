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
import { sendWithExpectedError } from './send-or-default';

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

  const data = await sendWithExpectedError(
    () =>
      s3Client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
      ),
    S3_NO_SUCH_LIFECYCLE_CONFIGURATION,
  );
  const existingRules: LifecycleRule[] = data?.Rules ?? [];

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
