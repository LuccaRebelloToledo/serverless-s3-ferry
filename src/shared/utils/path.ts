import path from 'node:path';

export function toS3Path(osPath: string): string {
  return osPath.replace(new RegExp(`\\${path.sep}`, 'g'), '/');
}

/**
 * Encodes characters that S3 does not handle well in object keys.
 * Required because AWS SDK v3 does not auto-encode CopySource/Key parameters.
 */
export function encodeSpecialCharacters(filename: string): string {
  return filename
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
