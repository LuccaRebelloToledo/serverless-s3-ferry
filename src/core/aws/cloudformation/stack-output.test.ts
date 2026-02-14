import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  type AwsProviderExtended,
  mockAwsIam,
  mockProvider,
  StackOutputError,
  TEST_BUCKET,
  TEST_STACK_NAME,
} from '@shared';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/aws/iam', () => mockAwsIam());

import { resolveStackOutput } from './stack-output';

describe('resolveStackOutput', () => {
  const cfnMock = mockClient(CloudFormationClient);

  beforeEach(() => {
    cfnMock.reset();
  });

  afterEach(() => {
    cfnMock.restore();
  });

  it('resolves output by key', async () => {
    cfnMock.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          Outputs: [{ OutputKey: 'BucketName', OutputValue: TEST_BUCKET }],
          StackName: TEST_STACK_NAME,
          StackStatus: 'CREATE_COMPLETE',
          CreationTime: new Date(),
        },
      ],
    });

    const result = await resolveStackOutput(
      mockProvider() as unknown as AwsProviderExtended,
      'BucketName',
    );
    expect(result).toBe(TEST_BUCKET);
  });

  it('throws StackOutputError when output key not found', async () => {
    cfnMock.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          Outputs: [{ OutputKey: 'Other', OutputValue: 'val' }],
          StackName: TEST_STACK_NAME,
          StackStatus: 'CREATE_COMPLETE',
          CreationTime: new Date(),
        },
      ],
    });

    await expect(
      resolveStackOutput(
        mockProvider() as unknown as AwsProviderExtended,
        'Missing',
      ),
    ).rejects.toThrow(StackOutputError);
  });

  it('throws StackOutputError when Stacks is empty or undefined', async () => {
    cfnMock.on(DescribeStacksCommand).resolves({ Stacks: [] });

    await expect(
      resolveStackOutput(
        mockProvider() as unknown as AwsProviderExtended,
        'BucketName',
      ),
    ).rejects.toThrow(StackOutputError);

    cfnMock.reset();
    cfnMock.on(DescribeStacksCommand).resolves({});

    await expect(
      resolveStackOutput(
        mockProvider() as unknown as AwsProviderExtended,
        'BucketName',
      ),
    ).rejects.toThrow(StackOutputError);
  });

  it('throws StackOutputError when no outputs exist', async () => {
    cfnMock.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackName: TEST_STACK_NAME,
          StackStatus: 'CREATE_COMPLETE',
          CreationTime: new Date(),
        },
      ],
    });

    await expect(
      resolveStackOutput(
        mockProvider() as unknown as AwsProviderExtended,
        'BucketName',
      ),
    ).rejects.toThrow(StackOutputError);
  });
});
