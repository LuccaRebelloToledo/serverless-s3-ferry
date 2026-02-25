import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { TEST_BUCKET } from '@shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAllObjects } from './list';

describe('listAllObjects', () => {
  const s3Mock = mockClient(S3Client);

  beforeEach(() => {
    s3Mock.reset();
  });

  afterEach(() => {
    s3Mock.restore();
  });

  async function generatorToArray<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const arr = [];
    for await (const val of gen) {
      arr.push(val);
    }
    return arr;
  }

  describe('basic functionality', () => {
    it('lists objects without pagination', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [
          { Key: 'file1.txt', ETag: '"abc123"', Size: 100 },
          { Key: 'file2.txt', ETag: '"def456"', Size: 200 },
        ],
        IsTruncated: false,
      });

      const client = new S3Client({});
      const result = await generatorToArray(
        listAllObjects(client, TEST_BUCKET, ''),
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        Key: 'file1.txt',
        ETag: '"abc123"',
        Size: 100,
      });
      expect(result[1]).toEqual({
        Key: 'file2.txt',
        ETag: '"def456"',
        Size: 200,
      });
    });

    it('lists objects with specific prefix', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: 'assets/style.css', ETag: '"xyz789"', Size: 300 }],
        IsTruncated: false,
      });

      const client = new S3Client({});
      const result = await generatorToArray(
        listAllObjects(client, TEST_BUCKET, 'assets/'),
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.Key).toBe('assets/style.css');

      const calls = s3Mock.commandCalls(ListObjectsV2Command);
      expect(calls[0]?.args[0].input.Prefix).toBe('assets/');
    });
  });

  describe('pagination handling', () => {
    it('handles two-page pagination with continuation token', async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolvesOnce({
          Contents: [{ Key: 'page1.txt', ETag: '"aaa"', Size: 10 }],
          IsTruncated: true,
          NextContinuationToken: 'token-1',
        })
        .resolvesOnce({
          Contents: [{ Key: 'page2.txt', ETag: '"bbb"', Size: 20 }],
          IsTruncated: false,
        });

      const client = new S3Client({});
      const result = await generatorToArray(
        listAllObjects(client, TEST_BUCKET, ''),
      );

      expect(result).toHaveLength(2);
      expect(result[0]?.Key).toBe('page1.txt');
      expect(result[1]?.Key).toBe('page2.txt');
    });

    it('handles three+ page pagination with multiple tokens', async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolvesOnce({
          Contents: [{ Key: 'page1.txt', ETag: '"aaa"', Size: 10 }],
          IsTruncated: true,
          NextContinuationToken: 'token-1',
        })
        .resolvesOnce({
          Contents: [{ Key: 'page2.txt', ETag: '"bbb"', Size: 20 }],
          IsTruncated: true,
          NextContinuationToken: 'token-2',
        })
        .resolvesOnce({
          Contents: [{ Key: 'page3.txt', ETag: '"ccc"', Size: 30 }],
          IsTruncated: false,
        });

      const client = new S3Client({});
      const result = await generatorToArray(
        listAllObjects(client, TEST_BUCKET, ''),
      );

      expect(result).toHaveLength(3);
      expect(result.map((obj) => obj.Key)).toEqual([
        'page1.txt',
        'page2.txt',
        'page3.txt',
      ]);
    });

    it('passes continuation token to subsequent requests', async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .resolvesOnce({
          Contents: [{ Key: 'file1.txt', ETag: '"aaa"', Size: 10 }],
          IsTruncated: true,
          NextContinuationToken: 'token-xyz',
        })
        .resolvesOnce({
          Contents: [{ Key: 'file2.txt', ETag: '"bbb"', Size: 20 }],
          IsTruncated: false,
        });

      const client = new S3Client({});
      await generatorToArray(listAllObjects(client, TEST_BUCKET, ''));

      const calls = s3Mock.commandCalls(ListObjectsV2Command);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.args[0].input.ContinuationToken).toBeUndefined();
      expect(calls[1]?.args[0].input.ContinuationToken).toBe('token-xyz');
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty bucket', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [],
        IsTruncated: false,
      });

      const client = new S3Client({});
      const result = await generatorToArray(
        listAllObjects(client, TEST_BUCKET, ''),
      );

      expect(result).toEqual([]);
    });

    it('handles undefined Contents field', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        IsTruncated: false,
      });

      const client = new S3Client({});
      const result = await generatorToArray(
        listAllObjects(client, TEST_BUCKET, ''),
      );

      expect(result).toEqual([]);
    });
  });
});
