import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocalFiles } from './files';

describe('getLocalFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function generatorToArray(
    gen: AsyncGenerator<string>,
  ): Promise<string[]> {
    const arr = [];
    for await (const val of gen) {
      arr.push(val);
    }
    return arr;
  }

  it('lists files recursively', async () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'sub', 'b.txt'), 'b');

    const files = await generatorToArray(getLocalFiles(tmpDir));
    const names = files.map((f) => path.relative(tmpDir, f)).sort();
    expect(names).toEqual(['a.txt', path.join('sub', 'b.txt')]);
  });

  it('ignores symlinks with warning', async () => {
    fs.writeFileSync(path.join(tmpDir, 'real.txt'), 'real');
    fs.symlinkSync(
      path.join(tmpDir, 'real.txt'),
      path.join(tmpDir, 'link.txt'),
    );

    const log = { error: vi.fn(), warning: vi.fn() };
    const files = await generatorToArray(getLocalFiles(tmpDir, log));

    expect(files).toHaveLength(1);
    expect(log.warning).toHaveBeenCalledWith(
      expect.stringContaining('symbolic link'),
    );
  });

  it('returns empty array for non-existent directory', async () => {
    const log = { error: vi.fn(), warning: vi.fn() };
    const files = await generatorToArray(
      getLocalFiles('/nonexistent/path', log),
    );
    expect(files).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('/nonexistent/path'),
    );
  });

  it('returns empty array for empty directory', async () => {
    const files = await generatorToArray(getLocalFiles(tmpDir));
    expect(files).toEqual([]);
  });
});
