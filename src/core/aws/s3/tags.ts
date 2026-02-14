import {
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { Tag } from '@shared';

export function mergeTags(existingTagSet: Tag[], tagsToMerge: Tag[]): void {
  for (const tag of tagsToMerge) {
    const existing = existingTagSet.find((et) => et.Key === tag.Key);
    if (existing) {
      existing.Value = tag.Value;
    } else {
      existingTagSet.push(tag);
    }
  }
}

export async function updateBucketTags(
  s3Client: S3Client,
  bucket: string,
  tagsToUpdate: Tag[],
): Promise<void> {
  let existingTagSet: Tag[] = [];

  try {
    const data = await s3Client.send(
      new GetBucketTaggingCommand({ Bucket: bucket }),
    );
    existingTagSet = (data.TagSet as Tag[]) ?? [];
  } catch (err: unknown) {
    // If there are no tags, S3 throws NoSuchTagSet — that's fine, start fresh
    if (err instanceof Error && err.name === 'NoSuchTagSet') {
      existingTagSet = [];
    } else {
      throw err;
    }
  }

  mergeTags(existingTagSet, tagsToUpdate);

  await s3Client.send(
    new PutBucketTaggingCommand({
      Bucket: bucket,
      Tagging: { TagSet: existingTagSet },
    }),
  );
}
