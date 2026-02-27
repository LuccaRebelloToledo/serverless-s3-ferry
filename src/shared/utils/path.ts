import path from 'node:path';

/**
 * Converts an OS-specific path to a normalized S3 key.
 * - Replaces backslashes with forward slashes.
 * - Removes leading slashes.
 * - Collapses multiple slashes into one.
 */
export function toS3Path(osPath: string): string {
  return osPath
    .replace(new RegExp(`\\${path.sep}`, 'g'), '/') // OS separators to /
    .replace(/\\/g, '/') // Force backslashes to / (Windows fallback)
    .replace(/\/+/g, '/') // Collapse multiple // to /
    .replace(/^\//, ''); // Remove leading /
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
