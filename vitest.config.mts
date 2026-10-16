import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
      '@core': path.resolve(import.meta.dirname, 'src/core'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        'src/shared/testing/**',
        'src/shared/index.ts',
        'src/shared/*/index.ts',
        'src/core/**/index.ts',
        'src/shared/types/*.ts',
      ],
    },
  },
});
