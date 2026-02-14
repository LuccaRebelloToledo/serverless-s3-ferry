import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeSpecialCharacters, toS3Path } from './path';

describe('toS3Path', () => {
  it('replaces path.sep with forward slashes', () => {
    // On Unix path.sep is '/', on Windows it's '\'
    // toS3Path normalizes OS-specific separators to '/'
    const input = ['foo', 'bar', 'baz'].join(path.sep);
    expect(toS3Path(input)).toBe('foo/bar/baz');
  });

  it('leaves unix paths unchanged', () => {
    expect(toS3Path('foo/bar/baz')).toBe('foo/bar/baz');
  });

  it('handles empty string', () => {
    expect(toS3Path('')).toBe('');
  });
});

describe('encodeSpecialCharacters', () => {
  it('encodes spaces and special characters', () => {
    expect(encodeSpecialCharacters('my file (1).txt')).toBe(
      'my%20file%20(1).txt',
    );
  });

  it('preserves forward slashes', () => {
    expect(encodeSpecialCharacters('dir/file name.txt')).toBe(
      'dir/file%20name.txt',
    );
  });

  it('encodes multiple segments independently', () => {
    expect(encodeSpecialCharacters('a b/c d/e f')).toBe('a%20b/c%20d/e%20f');
  });
});
