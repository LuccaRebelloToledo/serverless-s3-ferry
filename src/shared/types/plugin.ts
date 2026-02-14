import type Serverless from 'serverless';
import type Plugin from 'serverless/classes/Plugin';
import type Aws from 'serverless/plugins/aws/provider/awsProvider';

// Re-export the library types that we use directly
export type { Serverless, Plugin, Aws };

export interface ErrorLogger {
  error(message: string): void;
  warning(message: string): void;
}

export interface CachedAwsCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
}

// Extend Serverless.Options with our custom CLI flags
export interface S3FerryOptions extends Serverless.Options {
  nos3ferry?: boolean;
  offline?: string | boolean;
  bucket?: string;
  env?: string;
}

// Extend Aws provider with cachedCredentials (not typed in @types/serverless)
export interface AwsProviderExtended extends Aws {
  cachedCredentials?: CachedAwsCredentials;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
