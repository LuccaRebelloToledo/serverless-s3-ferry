import {
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { S3_NO_SUCH_TAG_SET, type Tag } from '@shared';

interface MergeTagsOptions {
  existingTagSet: Tag[];
  tagsToMerge: Tag[];
}

export function mergeTags(options: MergeTagsOptions): void {
  const { existingTagSet, tagsToMerge } = options;
  for (const tag of tagsToMerge) {
    const existing = existingTagSet.find((et) => et.Key === tag.Key);
    if (existing) {
      existing.Value = tag.Value;
    } else {
      existingTagSet.push(tag);
    }
  }
}

interface UpdateBucketTagsOptions {
  s3Client: S3Client;
  bucket: string;
  tagsToUpdate: Tag[];
}

export async function updateBucketTags(
  options: UpdateBucketTagsOptions,
): Promise<void> {
  const { s3Client, bucket, tagsToUpdate } = options;
  let existingTagSet: Tag[] = [];

  try {
    const data = await s3Client.send(
      new GetBucketTaggingCommand({ Bucket: bucket }),
    );
    existingTagSet = (data.TagSet as Tag[]) ?? [];
  } catch (err: unknown) {
    // If there are no tags, S3 throws NoSuchTagSet — that's fine, start fresh
    if (err instanceof Error && err.name === S3_NO_SUCH_TAG_SET) {
      existingTagSet = [];
    } else {
      throw err;
    }
  }

  mergeTags({ existingTagSet, tagsToMerge: tagsToUpdate });

  await s3Client.send(
    new PutBucketTaggingCommand({
      Bucket: bucket,
      Tagging: { TagSet: existingTagSet },
    }),
  );
}
