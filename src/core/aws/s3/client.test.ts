import type { AwsProviderExtended } from '@shared';
import {
  mockAwsIam,
  mockProvider,
  TEST_ACCESS_KEY,
  TEST_ENDPOINT,
  TEST_REGION,
  TEST_SECRET_KEY,
} from '@shared/testing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/aws/iam', () => mockAwsIam());

import { createS3Client } from './client';

describe('createS3Client', () => {
  it('creates client with endpoint and forcePathStyle when offline', () => {
    const client = createS3Client({
      provider: mockProvider() as unknown as AwsProviderExtended,
      endpoint: TEST_ENDPOINT,
      offline: true,
    });

    const config = client.config;
    expect(config.forcePathStyle).toBe(true);
  });

  it('creates client without forcePathStyle when no endpoint', () => {
    const client = createS3Client({
      provider: mockProvider() as unknown as AwsProviderExtended,
    });

    const config = client.config;
    expect(config.forcePathStyle).toBeFalsy();
  });

  it('creates client with correct region and credentials', async () => {
    const client = createS3Client({
      provider: mockProvider() as unknown as AwsProviderExtended,
    });

    const config = client.config;
    const region = await config.region();
    const credentials = await config.credentials();
    expect(region).toBe(TEST_REGION);
    expect(credentials.accessKeyId).toBe(TEST_ACCESS_KEY);
    expect(credentials.secretAccessKey).toBe(TEST_SECRET_KEY);
  });

  it('does not set forcePathStyle when endpoint exists but not offline', () => {
    const client = createS3Client({
      provider: mockProvider() as unknown as AwsProviderExtended,
      endpoint: TEST_ENDPOINT,
      offline: false,
    });

    const config = client.config;
    expect(config.forcePathStyle).toBeFalsy();
  });
});
