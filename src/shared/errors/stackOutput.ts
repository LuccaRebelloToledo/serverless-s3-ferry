import { S3FerryError } from './s3Ferry';

export class StackOutputError extends S3FerryError {
  constructor(message: string) {
    super(message);
    this.name = 'StackOutputError';
  }
}
