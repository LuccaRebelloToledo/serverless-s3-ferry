import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@core': path.resolve(__dirname, 'src/core'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        'src/shared/testing',
        'src/shared/index.ts',
        'src/shared/*/index.ts',
        'src/core/**/index.ts',
        'src/shared/types/*.ts',
      ],
    },
  },
});
