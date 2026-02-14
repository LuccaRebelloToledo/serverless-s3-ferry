import type { AwsProviderExtended } from '@shared';
import {
  mockProvider,
  TEST_ACCESS_KEY,
  TEST_REGION,
  TEST_SECRET_KEY,
} from '@shared/testing';
import { describe, expect, it } from 'vitest';
import { getAwsOptions } from './credentials';

describe('getAwsOptions', () => {
  it('uses cachedCredentials when complete', () => {
    const provider = mockProvider({
      cachedCredentials: {
        accessKeyId: TEST_ACCESS_KEY,
        secretAccessKey: TEST_SECRET_KEY,
        sessionToken: 'ST',
      },
    });

    const result = getAwsOptions(provider as unknown as AwsProviderExtended);
    expect(result.credentials).toEqual({
      accessKeyId: TEST_ACCESS_KEY,
      secretAccessKey: TEST_SECRET_KEY,
      sessionToken: 'ST',
    });
    expect(result.region).toBe(TEST_REGION);
  });

  it('falls back to getCredentials() when cache is incomplete', () => {
    const provider = mockProvider({
      cachedCredentials: { accessKeyId: TEST_ACCESS_KEY }, // missing secretAccessKey and sessionToken
      getCredentials: () => ({
        region: 'ap-southeast-1',
        credentials: { accessKeyId: 'AK2', secretAccessKey: 'SK2' },
      }),
    });

    const result = getAwsOptions(provider as unknown as AwsProviderExtended);
    expect(result.credentials).toEqual({
      accessKeyId: 'AK2',
      secretAccessKey: 'SK2',
    });
  });

  it('falls back to providerCredentials.region when getRegion is empty', () => {
    const provider = mockProvider({
      getRegion: () => '',
      getCredentials: () => ({ region: 'ap-southeast-1' }),
    });

    const result = getAwsOptions(provider as unknown as AwsProviderExtended);
    expect(result.region).toBe('ap-southeast-1');
  });

  it('uses DEFAULT_REGION as fallback', () => {
    const provider = mockProvider({
      getRegion: () => '',
      getCredentials: () => ({}),
    });

    const result = getAwsOptions(provider as unknown as AwsProviderExtended);
    expect(result.region).toBe(TEST_REGION);
  });
});
