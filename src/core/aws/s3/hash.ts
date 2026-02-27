import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Computes MD5 hash of a file using a stream to be memory efficient.
 * Returns the hash wrapped in double quotes to match S3 ETag format.
 */
export async function computeFileMD5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (data) => hash.update(data));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => {
      resolve(`"${hash.digest('hex')}"`);
    });
  });
}
