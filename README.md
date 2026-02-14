# serverless-s3-ferry

[![npm version](https://img.shields.io/npm/v/serverless-s3-ferry)](https://www.npmjs.com/package/serverless-s3-ferry)
[![license](https://img.shields.io/npm/l/serverless-s3-ferry)](LICENSE)
[![node](https://img.shields.io/node/v/serverless-s3-ferry)](package.json)
[![CI](https://github.com/LuccaRebelloToledo/serverless-s3-ferry/actions/workflows/ci.yml/badge.svg)](https://github.com/LuccaRebelloToledo/serverless-s3-ferry/actions/workflows/ci.yml)

A Serverless Framework plugin that syncs local directories to Amazon S3 buckets using AWS SDK v3. ⚡

## Background

This plugin was independently developed to provide S3 sync
capabilities for the Serverless Framework after the original
[`serverless-s3-sync`](https://github.com/k1LoW/serverless-s3-sync)
project was archived and is no longer maintained.

This implementation does not reuse any code from the original project.

## Features

- Sync local directories to S3 buckets on deploy and remove
- Per-file cache control and content type configuration via glob patterns
- Bucket tagging support (appends to existing tags)
- Resolve bucket names from CloudFormation stack outputs
- Conditional sync rules with the `enabled` flag
- Offline development support with `serverless-offline` and `serverless-s3-local`
- Custom lifecycle hook integration
- Concurrent uploads with configurable parallelism

## Table of Contents

- [Installation](#installation)
- [Compatibility](#compatibility)
- [Configuration](#configuration)
- [Usage](#usage)
- [Offline Usage](#offline-usage)
- [Advanced Configuration](#advanced-configuration)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Installation

```sh
npm install --save serverless-s3-ferry
```

Add the plugin to your `serverless.yml`:

```yaml
plugins:
  - serverless-s3-ferry
```

## Compatibility

| serverless-s3-ferry | Serverless Framework |
| ------------------- | -------------------- |
| >= v1.0.0           | v4.x                 |

## Configuration

```yaml
custom:
  s3Ferry:
    # A simple configuration for copying static assets
    - bucketName: my-static-site-assets # required
      bucketPrefix: assets/ # optional
      localDir: dist/assets # required

    # An example of possible configuration options
    - bucketName: my-other-site
      localDir: path/to/other-site
      deleteRemoved: true # optional, indicates whether sync deletes files no longer present in localDir. Defaults to 'true'
      acl: public-read # optional
      defaultContentType: text/html # optional
      params: # optional
        - index.html:
            CacheControl: 'no-cache'
        - "*.js":
            CacheControl: 'public, max-age=31536000'
      bucketTags: # optional, these are appended to existing S3 bucket tags (overwriting tags with the same key)
        tagKey1: tagValue1
        tagKey2: tagValue2

    # This references bucket name from the output of the current stack
    - bucketNameKey: AnotherBucketNameOutputKey
      localDir: path/to/another

    # ... but can also reference it from the output of another stack,
    # see https://www.serverless.com/framework/docs/providers/aws/guide/variables#reference-cloudformation-outputs
    - bucketName: ${cf:another-cf-stack-name.ExternalBucketOutputKey}
      localDir: path

    # Setting the optional enabled field to false will disable this rule.
    # Referencing other variables allows this rule to become conditional
    - bucketName: DisabledSync
      localDir: path
      enabled: false

resources:
  Resources:
    AssetsBucket:
      Type: AWS::S3::Bucket
      Properties:
        BucketName: my-static-site-assets
    OtherSiteBucket:
      Type: AWS::S3::Bucket
      Properties:
        BucketName: my-other-site
        AccessControl: PublicRead
        WebsiteConfiguration:
          IndexDocument: index.html
          ErrorDocument: error.html
    AnotherBucket:
      Type: AWS::S3::Bucket
  Outputs:
    AnotherBucketNameOutputKey:
      Value: !Ref AnotherBucket
```

## Usage

Run `sls deploy` -- local directories are synced to their configured S3 prefixes.

Run `sls remove` -- S3 objects in the configured prefixes are removed.

Run `sls deploy --nos3ferry` -- deploy without syncing.

Run `sls remove --nos3ferry` -- remove the stack without deleting S3 objects.

### `sls s3ferry`

Sync local directories and S3 prefixes on demand.

## Offline Usage

If you also use `serverless-offline` and `serverless-s3-local`, sync can be supported during development by placing the bucket configuration into the `buckets` object and specifying an alternate `endpoint`:

```yaml
custom:
  s3Ferry:
    # an alternate s3 endpoint
    endpoint: http://localhost:4569
    buckets:
    # A simple configuration for copying static assets
    - bucketName: my-static-site-assets # required
      bucketPrefix: assets/ # optional
      localDir: dist/assets # required
# ...
```

As per [serverless-s3-local's instructions](https://github.com/ar90n/serverless-s3-local#triggering-aws-events-offline), once a local credentials profile is configured, run `sls offline start --aws-profile s3local` to sync to the local S3 bucket instead of Amazon S3.

> `bucketNameKey` will not work in offline mode and can only be used in conjunction with valid AWS credentials. Use `bucketName` instead.

Run `sls deploy` for normal deployment.

## Advanced Configuration

### Disable auto sync

```yaml
custom:
  s3Ferry:
    # Disable sync when sls deploy and sls remove
    noSync: true
    buckets:
    # A simple configuration for copying static assets
    - bucketName: my-static-site-assets # required
      bucketPrefix: assets/ # optional
      localDir: dist/assets # required
# ...
```

### Sync on other hooks

```yaml
custom:
  s3Ferry:
    hooks:
      # This hook will run after the deploy:finalize hook
      - after:deploy:finalize
    buckets:
    # A simple configuration for copying static assets
    - bucketName: my-static-site-assets # required
      bucketPrefix: assets/ # optional
      localDir: dist/assets # required
# ...
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
