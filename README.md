# serverless-s3-ferry

[![npm version](https://img.shields.io/npm/v/serverless-s3-ferry)](https://www.npmjs.com/package/serverless-s3-ferry)
![CI](https://github.com/LuccaRebelloToledo/serverless-s3-ferry/actions/workflows/ci.yml/badge.svg)
![CodeQL](https://github.com/LuccaRebelloToledo/serverless-s3-ferry/actions/workflows/codeql.yml/badge.svg)
[![codecov](https://codecov.io/gh/LuccaRebelloToledo/serverless-s3-ferry/branch/main/graph/badge.svg)](https://codecov.io/gh/LuccaRebelloToledo/serverless-s3-ferry)
![license](https://img.shields.io/github/license/LuccaRebelloToledo/serverless-s3-ferry)

A Serverless Framework plugin that syncs local directories to Amazon S3 buckets using AWS SDK v3. ⚡

Built on AWS SDK v3 and actively maintained, it is a drop-in replacement for the archived [`serverless-s3-sync`](https://github.com/k1LoW/serverless-s3-sync) plugin.

## Background

This plugin was independently developed to provide S3 sync
capabilities for the Serverless Framework after the original
[`serverless-s3-sync`](https://github.com/k1LoW/serverless-s3-sync)
project was archived and is no longer maintained.

This implementation does not reuse any code from the original project.

## Features

- Sync local directories to S3 buckets on deploy and remove
- **High Performance**: Concurrent uploads and multipart support for large files (> 5GB)
- **Resilient**: Built-in adaptive retry strategy for handling throttling and network issues
- **Memory Efficient**: Uses Node.js async streams and generators for processing thousands of files
- Per-file cache control and content type configuration via glob patterns
- Bucket tagging support (appends to existing tags)
- Resolve bucket names from CloudFormation stack outputs
- Conditional sync rules with the `enabled` flag
- Offline development support with `serverless-offline` and `serverless-s3-local`
- Custom lifecycle hook integration

## Table of Contents

- [Installation](#installation)
- [Compatibility](#compatibility)
- [Configuration](#configuration)
- [Configuration Reference](#configuration-reference)
- [IAM Permissions](#iam-permissions)
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

| serverless-s3-ferry | Serverless Framework | Node.js    |
| ------------------- | -------------------- | ---------- |
| >= v1.0.0           | v4.x                 | >= 18.0.0  |

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
      preCommand: npm run build # optional, runs before sync
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
    - bucketName: conditional-bucket
      localDir: path
      enabled: ${param:syncEnabled, true}  # driven by deploy parameter

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

## Configuration Reference

### Per-bucket options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `bucketName` | string | — | Target S3 bucket name (required unless `bucketNameKey`) |
| `bucketNameKey` | string | — | CloudFormation output key resolving to bucket name |
| `localDir` | string | — | Local directory to sync (required) |
| `bucketPrefix` | string | `''` | S3 key prefix for uploaded files |
| `deleteRemoved` | boolean | `true` | Delete S3 objects absent from `localDir` |
| `acl` | string | `'private'` | S3 object ACL |
| `defaultContentType` | string | — | Fallback MIME type |
| `params` | array | `[]` | Per-file S3 params via glob patterns |
| `bucketTags` | object | — | Tags to merge into the bucket |
| `enabled` | boolean | `true` | Disable this sync rule when `false` |
| `preCommand` | string | — | Shell command to run before sync |

### Global options

These are set directly on the `s3Ferry` object (instead of using the array shorthand):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | string | — | Custom S3 endpoint (e.g., for local development) |
| `noSync` | boolean | `false` | Disable auto-sync on deploy/remove |
| `hooks` | string[] | `[]` | Additional lifecycle hooks to trigger sync |
| `buckets` | array | `[]` | Bucket config list (required when using global options) |

## IAM Permissions

To use this plugin, your AWS credentials must have the following permissions:

### S3 Permissions
- `s3:PutObject`
- `s3:GetObject`
- `s3:ListBucket`
- `s3:DeleteObject` (if `deleteRemoved` is true)
- `s3:GetBucketTagging` and `s3:PutBucketTagging` (if `bucketTags` is used)

### CloudFormation Permissions (optional)
- `cloudformation:DescribeStacks` (required only if using `bucketNameKey`)

## Usage

Run `sls deploy` -- local directories are synced to their configured S3 prefixes.

Run `sls remove` -- S3 objects in the configured prefixes are removed.

Run `sls deploy --nos3ferry` -- deploy without syncing.

Run `sls remove --nos3ferry` -- remove the stack without deleting S3 objects.

### `sls s3ferry`

Sync everything (files, metadata, and tags) on demand.

### `sls s3ferry:sync`
Sync files only.

### `sls s3ferry:metadata`
Sync metadata only (ACL, Cache-Control, etc.).

### `sls s3ferry:tags`
Sync bucket tags only.

### `sls s3ferry bucket`

Sync everything for a specific bucket only.

```sh
sls s3ferry bucket -b my-static-site-assets
```

You can also append `:sync`, `:metadata` or `:tags` to the bucket command:

```sh
# Sync only metadata for a specific bucket
sls s3ferry bucket:metadata -b my-static-site-assets
```

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

### Stage-scoped file params

Use the `OnlyForStage` param to upload a file only when a specific stage is active. This is useful for environment-specific configuration files:

```yaml
# Upload environment-specific files only to their respective stages
params:
  - "config/settings.dev.json":
      OnlyForStage: dev
  - "config/settings.staging.json":
      OnlyForStage: staging
  - "config/settings.prod.json":
      CacheControl: 'max-age=31536000'
      OnlyForStage: production
```

> **Note:** `OnlyForStage` is a special parameter handled by the plugin and is not sent to S3 as an object property.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
