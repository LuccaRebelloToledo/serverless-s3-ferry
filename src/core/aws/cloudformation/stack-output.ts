import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { getAwsOptions } from '@core/aws/iam';
import { type AwsProviderExtended, StackOutputError } from '@shared';

export async function resolveStackOutput(
  provider: AwsProviderExtended,
  outputKey: string,
): Promise<string> {
  const awsOptions = getAwsOptions(provider);
  const cfn = new CloudFormationClient({
    region: awsOptions.region,
    credentials: awsOptions.credentials,
  });

  const stackName = provider.naming['getStackName']?.();
  if (!stackName) {
    throw new StackOutputError(
      `Failed to resolve stack output '${outputKey}': stack name not found`,
    );
  }

  const result = await cfn.send(
    new DescribeStacksCommand({ StackName: stackName }),
  );

  const outputs = result.Stacks?.[0]?.Outputs;
  if (!outputs) {
    throw new StackOutputError(
      `Failed to resolve stack output '${outputKey}' in stack '${stackName}'`,
    );
  }

  const output = outputs.find((e) => e.OutputKey === outputKey);
  if (!output?.OutputValue) {
    throw new StackOutputError(
      `Output key '${outputKey}' not found in stack '${stackName}'`,
    );
  }

  return output.OutputValue;
}
