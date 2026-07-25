import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**'],
    testTimeout: 15_000,
  },
});
