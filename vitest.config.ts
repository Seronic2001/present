import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000, fileParallelism: false, watch: false, env: { PRESENT_LIBRARY: resolve('tests/.tmp/library') } },
});
