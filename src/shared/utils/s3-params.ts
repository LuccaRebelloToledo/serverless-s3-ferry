import { minimatch } from 'minimatch';
import { ONLY_FOR_STAGE_KEY } from '../constants/plugin';
import type { ParamMatcher, S3Params } from '../types/s3';

export interface ResolveS3ParamsOptions {
  relativePath: string;
  params?: ParamMatcher[];
  stage?: string;
  /**
   * When true, returns null if no pattern matched the file.
   * Used by metadata sync to only process files with explicit param matches.
   */
  skipUnmatched?: boolean;
}

/**
 * Resolves S3 parameters for a file by matching against glob patterns.
 * Uses relative paths for consistent matching between upload and metadata sync.
 *
 * Returns null if the file should be skipped (OnlyForStage mismatch, or
 * no pattern matched when skipUnmatched is true).
 * Returns accumulated S3 params with OnlyForStage stripped.
 *
 * OnlyForStage semantics: each pattern's OnlyForStage is evaluated independently.
 * The last matching pattern's OnlyForStage wins. If it doesn't match the current
 * stage, the file is skipped entirely.
 */
export function resolveS3Params(
  options: ResolveS3ParamsOptions,
): S3Params | null {
  const { relativePath, params, stage, skipUnmatched } = options;

  if (!params || params.length === 0) {
    return skipUnmatched ? null : {};
  }

  const s3Params: S3Params = {};
  let onlyForStage: string | undefined;
  let hasMatch = false;

  for (const param of params) {
    if (minimatch(relativePath, param.glob)) {
      hasMatch = true;
      Object.assign(s3Params, param.params);
      // Track OnlyForStage: reset per matching pattern
      if (param.params[ONLY_FOR_STAGE_KEY]) {
        onlyForStage = param.params[ONLY_FOR_STAGE_KEY];
      } else {
        // Later pattern without OnlyForStage clears it
        onlyForStage = undefined;
      }
    }
  }

  if (skipUnmatched && !hasMatch) {
    return null;
  }

  delete s3Params[ONLY_FOR_STAGE_KEY];

  if (onlyForStage && onlyForStage !== stage) {
    return null; // skip this file
  }

  return s3Params;
}
