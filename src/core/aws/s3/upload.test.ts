import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockProgress, TEST_BUCKET } from '@shared';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uploadDirectory } from './upload';

function md5Etag(content: string): string {
  return `"${crypto.createHash('md5').update(content).digest('hex')}"`;
}

describe('uploadDirectory', () => {
  const s3Mock = mockClient(S3Client);
  let tmpDir: string;

  beforeEach(() => {
    s3Mock.reset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
  });

  afterEach(() => {
    s3Mock.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uploads new files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>hello</h1>');

    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
    s3Mock.on(PutObjectCommand).resolves({});

    const client = new S3Client({});
    await uploadDirectory({
      s3Client: client,
      localDir: tmpDir,
      bucket: TEST_BUCKET,
      prefix: '',
      acl: 'private',
      deleteRemoved: false,
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Key).toBe('index.html');
    expect(putCalls[0].args[0].input.ContentType).toBe('text/html');
    expect(putCalls[0].args[0].input.Bucket).toBe(TEST_BUCKET);
    expect(putCalls[0].args[0].input.ACL).toBe('private');
  });

  it('uploads files in subdirectories with correct S3 keys', async () => {
    fs.mkdirSync(path.join(tmpDir, 'assets', 'images'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'assets', 'images', 'logo.png'), 'img');
    fs.writeFileSync(path.join(tmpDir, 'assets', 'style.css'), 'body{}');

    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
    s3Mock.on(PutObjectCommand).resolves({});

    const client = new S3Client({});
    await uploadDirectory({
      s3Client: client,
      localDir: tmpDir,
      bucket: TEST_BUCKET,
      prefix: '',
      acl: 'private',
      deleteRemoved: false,
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    const keys = putCalls.map((c) => c.args[0].input.Key).sort();
    expect(keys).toEqual(['assets/images/logo.png', 'assets/style.css']);
  });

  it('skips unchanged files (MD5 matches ETag)', async () => {
    const content = 'unchanged content';
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), content);

    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'file.txt', ETag: md5Etag(content) }],
    });

    const client = new S3Client({});
    await uploadDirectory({
      s3Client: client,
      localDir: tmpDir,
      bucket: TEST_BUCKET,
      prefix: '',
      acl: 'private',
      deleteRemoved: false,
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('deletes removed files when deleteRemoved is true', async () => {
    // No local files, but remote has one
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'old.txt', ETag: '"abc"' }],
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const client = new S3Client({});
    await uploadDirectory({
      s3Client: client,
      localDir: tmpDir,
      bucket: TEST_BUCKET,
      prefix: '',
      acl: 'private',
      deleteRemoved: true,
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Delete?.Objects).toEqual([
      { Key: 'old.txt' },
    ]);
  });

  it('does not delete when deleteRemoved is false', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'old.txt', ETag: '"abc"' }],
    });

    const client = new S3Client({});
    await uploadDirectory({
      s3Client: client,
      localDir: tmpDir,
      bucket: TEST_BUCKET,
      prefix: '',
      acl: 'private',
      deleteRemoved: false,
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  it('uses prefix in s3 key', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'data');

    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
    s3Mock.on(PutObjectCommand).resolves({});

    const client = new S3Client({});
    await uploadDirectory({
      s3Client: client,
      localDir: tmpDir,
      bucket: TEST_BUCKET,
      prefix: 'static/',
      acl: 'private',
      deleteRemoved: false,
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    expect(putCalls[0].args[0].input.Key).toBe('static/file.txt');
  });

  it('handles pagination for listing remote objects', async () => {
    fs.writeFileSync(path.join(tmpDir, 'new.txt'), 'new');

    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: 'existing1.txt', ETag: '"aaa"' }],
        IsTruncated: true,
        NextContinuationToken: 'token',
      })
      .resolvesOnce({
        Contents: [{ Key: 'existing2.txt', ETag: '"bbb"' }],
        IsTruncated: false,
      });
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const client = new S3Client({});
    await uploadDirectory({
      s3Client: client,
      localDir: tmpDir,
      bucket: TEST_BUCKET,
      prefix: '',
      acl: 'private',
      deleteRemoved: true,
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    // Should have listed twice
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(2);
    // Should upload the new file
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    // Should delete the two remote-only files
    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Delete?.Objects).toHaveLength(2);
  });

  it('batches delete in groups of 1000', async () => {
    // Create remote objects > 1000 with no local files
    const remoteContents = Array.from({ length: 1500 }, (_, i) => ({
      Key: `file-${i}.txt`,
      ETag: '"aaa"',
    }));
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: remoteContents,
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const client = new S3Client({});
    await uploadDirectory({
      s3Client: client,
      localDir: tmpDir,
      bucket: TEST_BUCKET,
      prefix: '',
      acl: 'private',
      deleteRemoved: true,
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0].args[0].input.Delete?.Objects).toHaveLength(1000);
    expect(deleteCalls[1].args[0].input.Delete?.Objects).toHaveLength(500);
  });

  it('applies default content type for unknown extensions', async () => {
    fs.writeFileSync(path.join(tmpDir, 'data.unknownext123'), 'stuff');

    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
    s3Mock.on(PutObjectCommand).resolves({});

    const client = new S3Client({});
    await uploadDirectory({
      s3Client: client,
      localDir: tmpDir,
      bucket: TEST_BUCKET,
      prefix: '',
      acl: 'private',
      deleteRemoved: false,
      defaultContentType: 'text/plain',
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    expect(putCalls[0].args[0].input.ContentType).toBe('text/plain');
  });
});
