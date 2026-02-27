import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeFileMD5 } from './hash';

describe('computeFileMD5', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computes MD5 hash correctly', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world');

    const hash = await computeFileMD5(filePath);
    // md5("hello world") = 5eb63bbbe01eeed093cb22bb8f5acdc3
    expect(hash).toBe('"5eb63bbbe01eeed093cb22bb8f5acdc3"');
  });

  it('rejects on stream error', async () => {
    const nonExistentPath = path.join(tmpDir, 'does-not-exist.txt');
    await expect(computeFileMD5(nonExistentPath)).rejects.toThrow();
  });
});
