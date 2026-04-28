import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['extensions/**/*.test.ts', 'extensions/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['extensions/**/*.ts'],
      exclude: ['extensions/**/*.test.ts', 'extensions/**/*.spec.ts', 'extensions/__tests__/**'],
    },
  },
});
