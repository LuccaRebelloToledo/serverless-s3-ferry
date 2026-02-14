export class S3FerryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S3FerryError';
  }
}
