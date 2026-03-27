import type { AwsProviderExtended, Plugin, RawBucketConfig } from '@shared';
import { mockAwsIam, mockProgress, mockProvider } from '@shared/testing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/aws/iam', () => mockAwsIam());

import { S3FerryCore } from './s3-ferry-core';

function mockLogging() {
  return {
    log: {
      error: vi.fn(),
      notice: vi.fn(),
      verbose: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    },
    progress: {
      create: vi.fn(() => mockProgress()),
    },
  } as unknown as Plugin.Logging;
}

describe('S3FerryCore', () => {
  it('defaults offline to false when not provided', () => {
    const logging = mockLogging();
    const core = new S3FerryCore({
      provider: mockProvider() as unknown as AwsProviderExtended,
      rawConfig: [] as RawBucketConfig[],
      servicePath: '/tmp',
      log: logging.log,
      progress: logging.progress,
    });

    // offline defaults to false — isOffline() should return false
    expect((core as unknown as { isOffline: () => boolean }).isOffline()).toBe(
      false,
    );
  });
});
