import { describe, expect, it } from 'vitest';
import { ConfigValidationError } from './configValidation';
import { S3FerryError } from './s3Ferry';
import { S3OperationError } from './s3Operation';
import { StackOutputError } from './stackOutput';

describe('S3FerryError', () => {
  it('has correct message and name', () => {
    const err = new S3FerryError('something failed');
    expect(err.message).toBe('something failed');
    expect(err.name).toBe('S3FerryError');
  });

  it('is instanceof Error', () => {
    expect(new S3FerryError('test')).toBeInstanceOf(Error);
  });
});

describe('ConfigValidationError', () => {
  it('extends S3FerryError', () => {
    const err = new ConfigValidationError('bad config');
    expect(err).toBeInstanceOf(S3FerryError);
    expect(err.name).toBe('ConfigValidationError');
    expect(err.message).toBe('bad config');
  });
});

describe('StackOutputError', () => {
  it('extends S3FerryError', () => {
    expect(new StackOutputError('test')).toBeInstanceOf(S3FerryError);
  });

  it('sets correct name and message', () => {
    const err = new StackOutputError('Custom error message');
    expect(err.message).toBe('Custom error message');
    expect(err.name).toBe('StackOutputError');
  });
});

describe('S3OperationError', () => {
  it('extends S3FerryError', () => {
    expect(new S3OperationError('fail')).toBeInstanceOf(S3FerryError);
  });

  it('has optional bucket field', () => {
    const err = new S3OperationError('op failed', 'my-bucket');
    expect(err.bucket).toBe('my-bucket');
    expect(err.name).toBe('S3OperationError');
  });

  it('works without bucket', () => {
    const err = new S3OperationError('op failed');
    expect(err.bucket).toBeUndefined();
  });
});
