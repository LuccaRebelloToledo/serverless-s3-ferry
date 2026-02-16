import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockProgress, TEST_BUCKET } from '@shared/testing';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncDirectoryMetadata } from './metadata';

describe('syncDirectoryMetadata', () => {
  const s3Mock = mockClient(S3Client);
  let tmpDir: string;

  beforeEach(() => {
    s3Mock.reset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-test-'));
  });

  afterEach(() => {
    s3Mock.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('file matching and filtering', () => {
    it('matches files with simple glob patterns', async () => {
      fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>test</h1>');
      fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body{}');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*.html': { CacheControl: 'max-age=3600' } }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.Key).toBe('index.html');
      expect(calls[0].args[0].input.CacheControl).toBe('max-age=3600');
    });

    it('matches files with directory patterns', async () => {
      fs.mkdirSync(path.join(tmpDir, 'assets', 'images'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'assets', 'images', 'logo.png'),
        'img',
      );
      fs.writeFileSync(path.join(tmpDir, 'assets', 'style.css'), 'css');
      fs.writeFileSync(path.join(tmpDir, 'index.html'), 'html');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ 'assets/**/*': { CacheControl: 'max-age=86400' } }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(2); // logo.png and style.css
      const keys = calls.map((c) => c.args[0].input.Key).sort();
      expect(keys).toEqual(['assets/images/logo.png', 'assets/style.css']);
    });

    it('applies last matching pattern when multiple patterns overlap', async () => {
      fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>test</h1>');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [
          { '*.html': { CacheControl: 'max-age=300' } },
          { 'index.html': { CacheControl: 'max-age=600' } },
        ],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls[0].args[0].input.CacheControl).toBe('max-age=600');
    });

    it('handles pattern priority with later patterns overriding earlier ones', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [
          { '*': { CacheControl: 'max-age=100' } },
          { '*.txt': { CacheControl: 'max-age=200' } },
        ],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      // Later pattern completely replaces earlier one
      expect(calls[0].args[0].input.CacheControl).toBe('max-age=200');
    });
  });

  describe('environment filtering', () => {
    it('includes files matching current environment', async () => {
      fs.writeFileSync(path.join(tmpDir, 'prod.js'), 'code');
      fs.writeFileSync(path.join(tmpDir, 'all.js'), 'code');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        env: 'production',
        params: [{ 'prod.js': { OnlyForEnv: 'production' } }, { 'all.js': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(2);
      const keys = calls.map((c) => c.args[0].input.Key).sort();
      expect(keys).toEqual(['all.js', 'prod.js']);
    });

    it('excludes files not matching current environment', async () => {
      fs.writeFileSync(path.join(tmpDir, 'dev.js'), 'code');
      fs.writeFileSync(path.join(tmpDir, 'prod.js'), 'code');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        env: 'production',
        params: [
          { 'dev.js': { OnlyForEnv: 'development' } },
          { 'prod.js': { OnlyForEnv: 'production' } },
        ],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.Key).toBe('prod.js');
    });

    it('handles undefined environment', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.js'), 'code');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ 'file.js': { OnlyForEnv: 'production' } }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(0);
    });

    it('removes OnlyForEnv from final parameters', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.js'), 'code');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        env: 'production',
        params: [
          {
            'file.js': {
              OnlyForEnv: 'production',
              CacheControl: 'max-age=300',
            },
          },
        ],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls[0].args[0].input.CacheControl).toBe('max-age=300');
    });

    it('skips file excluded by OnlyForEnv in first pattern but matches later pattern', async () => {
      fs.writeFileSync(path.join(tmpDir, 'config.js'), 'code');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        env: 'development',
        params: [
          { '*.js': { OnlyForEnv: 'production' } },
          { 'config.js': { CacheControl: 'max-age=3600' } },
        ],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      // File matches first pattern with OnlyForEnv=production, but env is development
      // So it's ignored and won't match the second pattern either
      expect(calls).toHaveLength(0);
    });
  });

  describe('content-type detection', () => {
    it('detects content type from file extension', async () => {
      fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>test</h1>');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*.html': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls[0].args[0].input.ContentType).toBe('text/html');
    });

    it('uses default content type for unknown extensions', async () => {
      fs.writeFileSync(path.join(tmpDir, 'data.unknownext'), 'stuff');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        defaultContentType: 'application/octet-stream',
        params: [{ '*.unknownext': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls[0].args[0].input.ContentType).toBe(
        'application/octet-stream',
      );
    });

    it('handles undefined content type when no detection and no default', async () => {
      fs.writeFileSync(path.join(tmpDir, 'data.unknown123'), 'stuff');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*.unknown123': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls[0].args[0].input.ContentType).toBeUndefined();
    });
  });

  describe('path construction', () => {
    it('constructs correct S3 keys without prefix', async () => {
      fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'index.html'), 'html');
      fs.writeFileSync(path.join(tmpDir, 'assets', 'style.css'), 'css');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*': {} }, { 'assets/*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      const keys = calls.map((c) => c.args[0].input.Key).sort();
      expect(keys).toEqual(['assets/style.css', 'index.html']);
    });

    it('constructs correct S3 keys with prefix', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: 'static/',
        acl: 'private',
        params: [{ '*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls[0].args[0].input.Key).toBe('static/file.txt');
    });

    it('normalizes bucket prefix with leading slash', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '/static/',
        acl: 'private',
        params: [{ '*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls[0].args[0].input.Key).toBe('static/file.txt');
    });

    it('constructs copySource paths correctly', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      const copySource = calls[0].args[0].input.CopySource;
      expect(copySource).toContain(TEST_BUCKET);
      expect(copySource).toContain('file.txt');
    });

    it('encodes special characters in paths', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file with spaces.txt'), 'data');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      const key = calls[0].args[0].input.Key;
      expect(key).toContain('%20');
    });
  });

  describe('parameter merging', () => {
    it('uses last matching pattern when multiple patterns match same file', async () => {
      fs.writeFileSync(path.join(tmpDir, 'index.html'), 'html');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [
          { '*.html': { CacheControl: 'max-age=3600' } },
          { 'index.html': { CacheControl: 'max-age=7200' } },
        ],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      // Later pattern (index.html) replaces earlier pattern (*.html)
      expect(calls[0].args[0].input.CacheControl).toBe('max-age=7200');
    });

    it('handles empty params', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.Bucket).toBe(TEST_BUCKET);
    });
  });

  describe('concurrency control', () => {
    it('respects limit of 5 concurrent operations', async () => {
      const fileCount = 12;
      for (let i = 0; i < fileCount; i++) {
        fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), 'data');
      }

      let activeCount = 0;
      let maxActive = 0;

      s3Mock.on(CopyObjectCommand).callsFake(async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeCount--;
        return {};
      });

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(fileCount);
      expect(maxActive).toBeLessThanOrEqual(5);
    });

    it('processes all files despite concurrency limit', async () => {
      const fileCount = 10;
      for (let i = 0; i < fileCount; i++) {
        fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), 'data');
      }

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(fileCount);
    });
  });

  describe('ignored files', () => {
    it('ignores .DS_Store files', async () => {
      fs.writeFileSync(path.join(tmpDir, 'index.html'), 'html');
      fs.writeFileSync(path.join(tmpDir, '.DS_Store'), 'junk');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.Key).toBe('index.html');
    });

    it('processes other hidden files with matching glob patterns', async () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'ignored');
      fs.writeFileSync(path.join(tmpDir, '.env'), 'vars');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '.*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(2);
      const keys = calls.map((c) => c.args[0].input.Key).sort();
      expect(keys).toContain('.env');
      expect(keys).toContain('.gitignore');
    });
  });

  describe('progress reporting', () => {
    it('updates progress on completion with 100 percent', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      const mockProgressLogger = mockProgress();
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*': {} }],
        progress: mockProgressLogger,
      });

      expect(mockProgressLogger.update).toHaveBeenCalledWith(
        expect.stringContaining('100%'),
      );
    });

    it('reports 0% for empty directory', async () => {
      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      const mockProgressLogger = mockProgress();
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*': {} }],
        progress: mockProgressLogger,
      });

      expect(mockProgressLogger.update).toHaveBeenCalledWith(
        expect.stringContaining('0%'),
      );
    });
  });

  describe('edge cases', () => {
    it('handles empty directory', async () => {
      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(0);
    });

    it('handles directory with only ignored files', async () => {
      fs.writeFileSync(path.join(tmpDir, '.DS_Store'), 'junk');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(0);
    });

    it('handles deeply nested files', async () => {
      fs.mkdirSync(path.join(tmpDir, 'a', 'b', 'c', 'd'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'a', 'b', 'c', 'd', 'deep.txt'),
        'data',
      );

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '**/*': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.Key).toBe('a/b/c/d/deep.txt');
    });

    it('handles files with same name in different directories', async () => {
      fs.mkdirSync(path.join(tmpDir, 'dir1'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'dir2'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'dir1', 'file.txt'), 'data1');
      fs.writeFileSync(path.join(tmpDir, 'dir2', 'file.txt'), 'data2');

      s3Mock.on(CopyObjectCommand).resolves({});

      const client = new S3Client({});
      await syncDirectoryMetadata({
        s3Client: client,
        localDir: tmpDir,
        bucket: TEST_BUCKET,
        bucketPrefix: '',
        acl: 'private',
        params: [{ '**/*.txt': {} }],
        progress: mockProgress(),
      });

      const calls = s3Mock.commandCalls(CopyObjectCommand);
      expect(calls).toHaveLength(2);
      const keys = calls.map((c) => c.args[0].input.Key).sort();
      expect(keys).toEqual(['dir1/file.txt', 'dir2/file.txt']);
    });
  });
});
