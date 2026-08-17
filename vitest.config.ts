import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'index.ts'],
      exclude: ['node_modules/**'],
    },
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    // Several driveStream regression tests share one physical scan-cache /
    // dynamic-config file and serialize on a cross-process lock (see
    // test/helpers/router-state-lock.ts) to avoid racing each other. Under
    // full parallelism the lock queue can legitimately exceed vitest's 5s
    // default before a test even starts running.
    testTimeout: 30_000,
  },
});
