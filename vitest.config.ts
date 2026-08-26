import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'index.ts'],
      exclude: ['node_modules/**'],
      // Floor, not a target: CI fails if coverage drops below this. Set a
      // few points below the measured baseline (2026-08-26: ~70.5% stmts/
      // lines, ~80.7% branch, ~72% funcs) so normal variance doesn't flake
      // the build, while a real regression (e.g. a large untested file) is
      // still caught. Ratchet these up as coverage improves — lowering them
      // to "fix" a failing CI run defeats the purpose.
      thresholds: {
        statements: 68,
        branches: 78,
        functions: 68,
        lines: 68,
      },
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
