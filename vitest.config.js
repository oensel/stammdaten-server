import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.js'], globalSetup: ['test/globalSetup.js'], testTimeout: 30000, hookTimeout: 60000, fileParallelism: false },
});
