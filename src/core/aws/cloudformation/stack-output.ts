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

  const stackName = provider.naming.getStackName();

  const result = await cfn.send(
    new DescribeStacksCommand({ StackName: stackName }),
  );

  const outputs = result.Stacks?.[0]?.Outputs;
  if (!outputs) {
    throw new StackOutputError(outputKey, stackName);
  }

  const output = outputs.find((e) => e.OutputKey === outputKey);
  if (!output?.OutputValue) {
    throw new StackOutputError(outputKey, stackName);
  }

  return output.OutputValue;
}
