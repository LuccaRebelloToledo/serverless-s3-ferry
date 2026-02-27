import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { getAwsOptions } from '@core/aws/iam';
import { type AwsProviderExtended, StackOutputError } from '@shared';

const cfnClientsByRegion = new Map<string, CloudFormationClient>();

function getCloudFormationClient(
  provider: AwsProviderExtended,
): CloudFormationClient {
  const awsOptions = getAwsOptions(provider);
  const region = awsOptions.region;

  let client = cfnClientsByRegion.get(region);
  if (!client) {
    client = new CloudFormationClient({
      region,
      credentials: awsOptions.credentials,
    });
    cfnClientsByRegion.set(region, client);
  }
  return client;
}

export async function resolveStackOutput(
  provider: AwsProviderExtended,
  outputKey: string,
): Promise<string> {
  const cfn = getCloudFormationClient(provider);

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
