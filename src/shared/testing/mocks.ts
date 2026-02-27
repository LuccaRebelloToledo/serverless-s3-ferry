import type { AwsProviderExtended, Plugin } from '@shared';
import { vi } from 'vitest';
import {
  TEST_ACCESS_KEY,
  TEST_REGION,
  TEST_SECRET_KEY,
  TEST_STACK_NAME,
} from './constants';

type MockProvider = Pick<AwsProviderExtended, 'cachedCredentials'> & {
  getRegion: () => string;
  getCredentials: () => Record<string, unknown>;
  naming: { getStackName: () => string };
};

export function mockProvider(
  overrides: Partial<MockProvider> = {},
): MockProvider {
  return {
    getRegion: () => TEST_REGION,
    getCredentials: () => ({}),
    cachedCredentials: undefined,
    naming: { getStackName: () => TEST_STACK_NAME },
    ...overrides,
  };
}

export function mockProgress(): Plugin.Progress {
  return {
    namespace: 'test',
    name: 'test',
    update: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    remove: vi.fn(),
  };
}

export function mockAwsIam() {
  return {
    getAwsOptions: () => ({
      region: TEST_REGION,
      credentials: {
        accessKeyId: TEST_ACCESS_KEY,
        secretAccessKey: TEST_SECRET_KEY,
      },
    }),
  };
}

export function mockLogging() {
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

export async function generatorToArray<T>(
  gen: AsyncGenerator<T>,
): Promise<T[]> {
  const arr: T[] = [];
  for await (const val of gen) {
    arr.push(val);
  }
  return arr;
}
