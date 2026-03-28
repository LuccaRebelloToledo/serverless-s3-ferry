import { S3FerryError } from './s3Ferry';

export class S3OperationError extends S3FerryError {
  readonly bucket?: string;

  constructor(message: string, bucket?: string) {
    super(message);
    this.name = 'S3OperationError';
    this.bucket = bucket;
  }
}
