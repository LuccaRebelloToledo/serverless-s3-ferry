import { S3FerryError } from './s3Ferry';

export class ConfigValidationError extends S3FerryError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}
