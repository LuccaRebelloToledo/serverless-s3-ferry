import { S3FerryError } from './s3Ferry';

export class S3OperationError extends S3FerryError {
  constructor(
    message: string,
    public readonly bucket?: string,
  ) {
    super(message);
    this.name = 'S3OperationError';
  }
}
