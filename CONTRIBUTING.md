# Contributing to serverless-s3-ferry

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

1. Fork and clone the repository
2. Install dependencies:
   ```sh
   npm install
   ```
3. Build the project:
   ```sh
   npm run build
   ```
4. Run the test suite:
   ```sh
   npm test
   ```

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting. Run the linter with:

```sh
npm run check
```

[Husky](https://typicode.github.io/husky/) pre-commit hooks are configured to run lint-staged automatically, so linting is enforced on every commit.

## Testing

Tests are written with [Vitest](https://vitest.dev/) and follow the `*.test.ts` convention, colocated with the source files they cover.

Run tests:

```sh
npm test
```

Watch mode:

```sh
npm run test:watch
```

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Ensure all tests pass (`npm test`)
4. Ensure the linter is clean (`npm run check`)
5. Open a pull request against `main`

## Reporting Issues

Use the [GitHub issue tracker](https://github.com/LuccaRebelloToledo/serverless-s3-ferry/issues) to report bugs or request features.

For security vulnerabilities, please see [SECURITY.md](SECURITY.md).
