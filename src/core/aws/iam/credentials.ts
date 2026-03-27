import {
  type AwsCredentials,
  type AwsProviderExtended,
  DEFAULT_REGION,
} from '@shared';

interface AwsClientOptions {
  region: string;
  credentials?: AwsCredentials;
}

export function getAwsOptions(provider: AwsProviderExtended): AwsClientOptions {
  if (
    provider.cachedCredentials?.accessKeyId &&
    provider.cachedCredentials.secretAccessKey &&
    provider.cachedCredentials.sessionToken
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
      provider.getRegion() || providerCredentials['region'] || DEFAULT_REGION,
    credentials: providerCredentials['credentials'] as
      | AwsCredentials
      | undefined,
  };
}
