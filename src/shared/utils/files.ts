import fs from 'node:fs';
import path from 'node:path';
import type { ErrorLogger } from '@shared';

/**
 * Lists all files in a directory recursively using an async generator
 * to be memory efficient.
 */
export async function* getLocalFiles(
  dir: string,
  log?: ErrorLogger,
): AsyncGenerator<string> {
  try {
    await fs.promises.access(dir, fs.constants.R_OK);
  } catch {
    log?.error(`The directory ${dir} does not exist.`);
    return;
  }

  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      log?.warning(`Ignoring symbolic link: ${fullPath}`);
      continue;
    }

    if (entry.isDirectory()) {
      yield* getLocalFiles(fullPath, log);
    } else {
      yield fullPath;
    }
  }
}
