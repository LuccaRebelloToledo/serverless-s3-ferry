import {
  type AwsCredentials,
  type AwsProviderExtended,
  DEFAULT_REGION,
} from '@shared';

export interface AwsClientOptions {
  region: string;
  credentials?: AwsCredentials;
}

export function getAwsOptions(provider: AwsProviderExtended): AwsClientOptions {
  if (
    provider.cachedCredentials &&
    typeof provider.cachedCredentials.accessKeyId !== 'undefined' &&
    typeof provider.cachedCredentials.secretAccessKey !== 'undefined' &&
    typeof provider.cachedCredentials.sessionToken !== 'undefined'
  ) {
    return {
      region: provider.getRegion(),
      credentials: {
        accessKeyId: provider.cachedCredentials.accessKeyId,
        secretAccessKey: provider.cachedCredentials.secretAccessKey,
        sessionToken: provider.cachedCredentials.sessionToken,
      },
    };
  }

  const providerCredentials = provider.getCredentials();
  return {
    region:
      provider.getRegion() || providerCredentials.region || DEFAULT_REGION,
    credentials: providerCredentials.credentials as AwsCredentials | undefined,
  };
}
