import fs from 'node:fs';
import path from 'node:path';
import type { ErrorLogger } from '@shared';

export function getLocalFiles(dir: string, log?: ErrorLogger): string[] {
  const files: string[] = [];
  collectFiles(dir, files, log);
  return files;
}

function collectFiles(dir: string, files: string[], log?: ErrorLogger): void {
  try {
    fs.accessSync(dir, fs.constants.R_OK);
  } catch {
    log?.error(`The directory ${dir} does not exist.`);
    return;
  }

  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    try {
      fs.accessSync(fullPath, fs.constants.R_OK);
    } catch {
      log?.error(`The file ${fullPath} does not exist.`);
      continue;
    }

    const stat = fs.lstatSync(fullPath);

    if (stat.isSymbolicLink()) {
      log?.warning(`Ignoring symbolic link: ${fullPath}`);
      continue;
    }

    if (stat.isDirectory()) {
      collectFiles(fullPath, files, log);
    } else {
      files.push(fullPath);
    }
  }
}
