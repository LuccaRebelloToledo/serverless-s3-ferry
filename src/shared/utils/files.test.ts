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

  it('lists files recursively', () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'sub', 'b.txt'), 'b');

    const files = getLocalFiles(tmpDir);
    const names = files.map((f) => path.relative(tmpDir, f)).sort();
    expect(names).toEqual(['a.txt', path.join('sub', 'b.txt')]);
  });

  it('ignores symlinks with warning', () => {
    fs.writeFileSync(path.join(tmpDir, 'real.txt'), 'real');
    fs.symlinkSync(
      path.join(tmpDir, 'real.txt'),
      path.join(tmpDir, 'link.txt'),
    );

    const log = { error: vi.fn(), warning: vi.fn() };
    const files = getLocalFiles(tmpDir, log);

    expect(files).toHaveLength(1);
    expect(log.warning).toHaveBeenCalledWith(
      expect.stringContaining('symbolic link'),
    );
  });

  it('returns empty array for non-existent directory', () => {
    const log = { error: vi.fn(), warning: vi.fn() };
    const files = getLocalFiles('/nonexistent/path', log);
    expect(files).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('/nonexistent/path'),
    );
  });

  it('skips files without read permission and logs error', () => {
    fs.writeFileSync(path.join(tmpDir, 'readable.txt'), 'ok');
    fs.writeFileSync(path.join(tmpDir, 'unreadable.txt'), 'no');

    const accessSyncOriginal = fs.accessSync;
    const spy = vi.spyOn(fs, 'accessSync').mockImplementation((p, mode) => {
      if (String(p).includes('unreadable.txt')) {
        throw new Error('EACCES');
      }
      return accessSyncOriginal.call(fs, p, mode);
    });

    try {
      const log = { error: vi.fn(), warning: vi.fn() };
      const files = getLocalFiles(tmpDir, log);

      expect(files).toHaveLength(1);
      expect(files[0]).toContain('readable.txt');
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('unreadable.txt'),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('returns empty array for empty directory', () => {
    const files = getLocalFiles(tmpDir);
    expect(files).toEqual([]);
  });
});
