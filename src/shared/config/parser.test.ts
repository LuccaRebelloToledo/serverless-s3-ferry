import {
  buildParamMatchers,
  ConfigValidationError,
  extractMetaParams,
  getBucketConfigs,
  getCustomHooks,
  getEndpoint,
  getNoSync,
  parseBucketConfig,
} from '@shared';
import { describe, expect, it } from 'vitest';

describe('getBucketConfigs', () => {
  it('returns array input as-is', () => {
    const input = [{ bucketName: 'bucket-a', localDir: '.' }];
    expect(getBucketConfigs(input)).toBe(input);
  });

  it('extracts buckets from object config', () => {
    const buckets = [{ bucketName: 'bucket-a', localDir: '.' }];
    expect(getBucketConfigs({ buckets })).toBe(buckets);
  });

  it('returns null when object has no buckets', () => {
    expect(getBucketConfigs({ endpoint: 'http://localhost' })).toBeNull();
  });
});

describe('parseBucketConfig', () => {
  it('parses minimal valid config', () => {
    const result = parseBucketConfig({
      bucketName: 'my-bucket',
      localDir: './dist',
    });
    expect(result.bucketName).toBe('my-bucket');
    expect(result.localDir).toBe('./dist');
  });

  it('applies defaults', () => {
    const result = parseBucketConfig({
      bucketName: 'bucket-b',
      localDir: '.',
    });
    expect(result.bucketPrefix).toBe('');
    expect(result.acl).toBe('private');
    expect(result.enabled).toBe(true);
    expect(result.deleteRemoved).toBe(true);
    expect(result.params).toEqual([]);
  });

  it('throws ConfigValidationError without bucketName and bucketNameKey', () => {
    expect(() => parseBucketConfig({ localDir: '.' })).toThrow(
      ConfigValidationError,
    );
  });

  it('throws ConfigValidationError without localDir', () => {
    expect(() => parseBucketConfig({ bucketName: 'bucket-b' })).toThrow(
      ConfigValidationError,
    );
  });

  it('accepts bucketNameKey instead of bucketName', () => {
    const result = parseBucketConfig({
      bucketNameKey: 'MyOutputKey',
      localDir: '.',
    });
    expect(result.bucketNameKey).toBe('MyOutputKey');
  });

  it('passes through multipart options', () => {
    const result = parseBucketConfig({
      bucketName: 'bucket',
      localDir: '.',
      multipartThreshold: 10 * 1024 * 1024,
      partSize: 10 * 1024 * 1024,
      queueSize: 2,
      abortIncompleteMultipartUploadDays: 14,
    });
    expect(result.multipartThreshold).toBe(10 * 1024 * 1024);
    expect(result.partSize).toBe(10 * 1024 * 1024);
    expect(result.queueSize).toBe(2);
    expect(result.abortIncompleteMultipartUploadDays).toBe(14);
  });

  it('defaults multipart options to undefined when not provided', () => {
    const result = parseBucketConfig({
      bucketName: 'bucket',
      localDir: '.',
    });
    expect(result.multipartThreshold).toBeUndefined();
    expect(result.partSize).toBeUndefined();
    expect(result.queueSize).toBeUndefined();
  });

  it('throws ConfigValidationError when partSize is below 5 MiB', () => {
    expect(() =>
      parseBucketConfig({
        bucketName: 'bucket',
        localDir: '.',
        partSize: 1024 * 1024, // 1 MiB
      }),
    ).toThrow(ConfigValidationError);
  });

  it('throws ConfigValidationError when partSize exceeds 5 GiB', () => {
    expect(() =>
      parseBucketConfig({
        bucketName: 'bucket',
        localDir: '.',
        partSize: 6 * 1024 * 1024 * 1024, // 6 GiB
      }),
    ).toThrow(ConfigValidationError);
  });

  it('accepts partSize at exact boundaries', () => {
    expect(() =>
      parseBucketConfig({
        bucketName: 'bucket',
        localDir: '.',
        partSize: 5 * 1024 * 1024, // 5 MiB (min)
      }),
    ).not.toThrow();

    expect(() =>
      parseBucketConfig({
        bucketName: 'bucket',
        localDir: '.',
        partSize: 5 * 1024 * 1024 * 1024, // 5 GiB (max)
      }),
    ).not.toThrow();
  });

  it('throws ConfigValidationError when queueSize is less than 1', () => {
    expect(() =>
      parseBucketConfig({
        bucketName: 'bucket',
        localDir: '.',
        queueSize: 0,
      }),
    ).toThrow(ConfigValidationError);
  });

  it('throws ConfigValidationError when multipartThreshold is negative', () => {
    expect(() =>
      parseBucketConfig({
        bucketName: 'bucket',
        localDir: '.',
        multipartThreshold: -1,
      }),
    ).toThrow(ConfigValidationError);
  });

  it('accepts multipartThreshold of 0', () => {
    const result = parseBucketConfig({
      bucketName: 'bucket',
      localDir: '.',
      multipartThreshold: 0,
    });
    expect(result.multipartThreshold).toBe(0);
  });

  it('throws ConfigValidationError when abortIncompleteMultipartUploadDays is less than 1', () => {
    expect(() =>
      parseBucketConfig({
        bucketName: 'bucket',
        localDir: '.',
        abortIncompleteMultipartUploadDays: 0,
      }),
    ).toThrow(ConfigValidationError);
  });

  it('accepts abortIncompleteMultipartUploadDays of 1', () => {
    const result = parseBucketConfig({
      bucketName: 'bucket',
      localDir: '.',
      abortIncompleteMultipartUploadDays: 1,
    });
    expect(result.abortIncompleteMultipartUploadDays).toBe(1);
  });
});

describe('extractMetaParams', () => {
  it('extracts params from config', () => {
    const result = extractMetaParams({
      '*.html': { CacheControl: 'max-age=300' },
    });
    expect(result).toEqual({ CacheControl: 'max-age=300' });
  });

  it('merges multiple keys', () => {
    const result = extractMetaParams({
      '*.html': { CacheControl: 'max-age=300' },
      '*.js': { ContentEncoding: 'gzip' },
    });
    expect(result).toEqual({
      CacheControl: 'max-age=300',
      ContentEncoding: 'gzip',
    });
  });
});

describe('buildParamMatchers', () => {
  it('builds matchers with glob and params', () => {
    const result = buildParamMatchers([
      { '*.html': { CacheControl: 'max-age=300' } },
      { '*.js': { ContentEncoding: 'gzip' } },
    ]);
    expect(result).toEqual([
      { glob: '*.html', params: { CacheControl: 'max-age=300' } },
      { glob: '*.js', params: { ContentEncoding: 'gzip' } },
    ]);
  });

  it('filters out entries with empty object (no glob key)', () => {
    const result = buildParamMatchers([
      { '*.html': { CacheControl: 'max-age=300' } },
      {} as Record<string, never>,
    ]);
    expect(result).toEqual([
      { glob: '*.html', params: { CacheControl: 'max-age=300' } },
    ]);
  });
});

describe('getNoSync', () => {
  it('returns true when optionNoSync is true', () => {
    expect(getNoSync({ rawConfig: [], optionNoSync: true })).toBe(true);
  });

  it('returns false for array config', () => {
    expect(getNoSync({ rawConfig: [] })).toBe(false);
  });

  it('handles string "TRUE" case-insensitive', () => {
    expect(getNoSync({ rawConfig: { noSync: 'TRUE' } })).toBe(true);
    expect(getNoSync({ rawConfig: { noSync: 'true' } })).toBe(true);
    expect(getNoSync({ rawConfig: { noSync: 'True' } })).toBe(true);
  });

  it('defaults to false', () => {
    expect(getNoSync({ rawConfig: {} })).toBe(false);
  });
});

describe('getEndpoint', () => {
  it('returns null for array config', () => {
    expect(getEndpoint([])).toBeNull();
  });

  it('extracts endpoint', () => {
    expect(getEndpoint({ endpoint: 'http://localhost:4569' })).toBe(
      'http://localhost:4569',
    );
  });

  it('returns null when no endpoint', () => {
    expect(getEndpoint({})).toBeNull();
  });
});

describe('getCustomHooks', () => {
  it('returns empty array for array config', () => {
    expect(getCustomHooks([])).toEqual([]);
  });

  it('extracts hooks', () => {
    expect(getCustomHooks({ hooks: ['before:deploy'] })).toEqual([
      'before:deploy',
    ]);
  });

  it('returns empty array when no hooks', () => {
    expect(getCustomHooks({})).toEqual([]);
  });
});
