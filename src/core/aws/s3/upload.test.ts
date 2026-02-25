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
import { mockProgress, TEST_BUCKET } from '@shared/testing';
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
    const putCall = putCalls[0];
    if (!putCall) throw new Error('Expected PutObjectCommand call');
    expect(putCall.args[0].input.Key).toBe('index.html');
    expect(putCall.args[0].input.ContentType).toBe('text/html');
    expect(putCall.args[0].input.Bucket).toBe(TEST_BUCKET);
    expect(putCall.args[0].input.ACL).toBe('private');
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
    const deleteCall = deleteCalls[0];
    if (!deleteCall) throw new Error('Expected DeleteObjectsCommand call');
    expect(deleteCall.args[0].input.Delete?.Objects).toEqual([
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
    const putCall = putCalls[0];
    if (!putCall) throw new Error('Expected PutObjectCommand call');
    expect(putCall.args[0].input.Key).toBe('static/file.txt');
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
    const deleteCall = deleteCalls[0];
    if (!deleteCall) throw new Error('Expected DeleteObjectsCommand call');
    expect(deleteCall.args[0].input.Delete?.Objects).toHaveLength(2);
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
    const deleteCall0 = deleteCalls[0];
    const deleteCall1 = deleteCalls[1];
    if (!deleteCall0 || !deleteCall1)
      throw new Error('Expected DeleteObjectsCommand calls');
    expect(deleteCall0.args[0].input.Delete?.Objects).toHaveLength(1000);
    expect(deleteCall1.args[0].input.Delete?.Objects).toHaveLength(500);
  });

  it('includes file when OnlyForStage matches current stage', async () => {
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
      params: [
        {
          glob: '*.html',
          params: { CacheControl: 'max-age=300', OnlyForStage: 'prod' },
        },
      ],
      stage: 'prod',
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    expect(putCalls).toHaveLength(1);
    const putCall = putCalls[0];
    if (!putCall) throw new Error('Expected PutObjectCommand call');
    // OnlyForStage should be stripped from the params sent to S3
    expect(
      (putCall.args[0].input as unknown as Record<string, unknown>)[
        'OnlyForStage'
      ],
    ).toBeUndefined();
    expect(putCall.args[0].input.CacheControl).toBe('max-age=300');
  });

  it('skips file when OnlyForStage does not match current stage', async () => {
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
      params: [{ glob: '*.html', params: { OnlyForStage: 'prod' } }],
      stage: 'dev',
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('skips file when OnlyForStage is set but stage is undefined', async () => {
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
      params: [{ glob: '*.html', params: { OnlyForStage: 'prod' } }],
      stage: undefined,
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
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
    const putCall = putCalls[0];
    if (!putCall) throw new Error('Expected PutObjectCommand call');
    expect(putCall.args[0].input.ContentType).toBe('text/plain');
  });

  it('falls back to application/octet-stream when mime and defaultContentType are both null', async () => {
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
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    const putCall = putCalls[0];
    if (!putCall) throw new Error('Expected PutObjectCommand call');
    expect(putCall.args[0].input.ContentType).toBe('application/octet-stream');
  });

  it('does not delete remote keys that exist locally when deleteRemoved is true', async () => {
    const content = 'hello';
    fs.writeFileSync(path.join(tmpDir, 'exists.txt'), content);

    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'exists.txt', ETag: '"different"' },
        { Key: 'orphan.txt', ETag: '"abc"' },
      ],
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

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(1);
    const deleteCall = deleteCalls[0];
    if (!deleteCall) throw new Error('Expected DeleteObjectsCommand call');
    // Only orphan.txt should be deleted, not exists.txt
    expect(deleteCall.args[0].input.Delete?.Objects).toEqual([
      { Key: 'orphan.txt' },
    ]);
  });

  it('applies matching params without OnlyForStage', async () => {
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
      params: [{ glob: '*.html', params: { CacheControl: 'max-age=300' } }],
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    expect(putCalls).toHaveLength(1);
    const putCall = putCalls[0];
    if (!putCall) throw new Error('Expected PutObjectCommand call');
    expect(putCall.args[0].input.CacheControl).toBe('max-age=300');
  });

  it('applies params only to matching files and ignores non-matching globs', async () => {
    fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body{}');

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
      params: [{ glob: '*.html', params: { CacheControl: 'max-age=300' } }],
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    expect(putCalls).toHaveLength(1);
    const putCall = putCalls[0];
    if (!putCall) throw new Error('Expected PutObjectCommand call');
    // CacheControl should NOT be applied since style.css doesn't match *.html
    expect(putCall.args[0].input.CacheControl).toBeUndefined();
  });

  it('preserves prior OnlyForStage via || fallback when later param has no OnlyForStage', async () => {
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
      params: [
        { glob: '*.html', params: { OnlyForStage: 'prod' } },
        { glob: '**/*', params: { CacheControl: 'max-age=60' } },
      ],
      stage: 'prod',
      progress: mockProgress(),
      servicePath: tmpDir,
    });

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    expect(putCalls).toHaveLength(1);
    const putCall = putCalls[0];
    if (!putCall) throw new Error('Expected PutObjectCommand call');
    expect(putCall.args[0].input.CacheControl).toBe('max-age=60');
  });
});
