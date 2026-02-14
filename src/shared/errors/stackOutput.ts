import { S3FerryError } from './s3Ferry';

export class StackOutputError extends S3FerryError {
  constructor(outputKey: string, stackName: string) {
    super(
      `Failed to resolve stack Output '${outputKey}' in stack '${stackName}'`,
    );
    this.name = 'StackOutputError';
  }
}
