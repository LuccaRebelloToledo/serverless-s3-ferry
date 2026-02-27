import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeSpecialCharacters, toS3Path } from './path';

describe('toS3Path', () => {
  it('replaces OS-specific separators with forward slashes', () => {
    // Unix: foo/bar/baz
    // Windows: foo\bar\baz
    const input = ['foo', 'bar', 'baz'].join(path.sep);
    expect(toS3Path(input)).toBe('foo/bar/baz');
  });

  it('removes leading slashes', () => {
    expect(toS3Path('/foo/bar')).toBe('foo/bar');
    expect(toS3Path('///foo/bar')).toBe('foo/bar');
  });

  it('collapses multiple slashes', () => {
    expect(toS3Path('foo//bar///baz')).toBe('foo/bar/baz');
  });

  it('forces backslashes to forward slashes regardless of OS', () => {
    expect(toS3Path('windows\\path\\style')).toBe('windows/path/style');
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
