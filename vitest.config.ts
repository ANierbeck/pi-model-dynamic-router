import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'index.ts'],
      exclude: ['node_modules/**'],
      // Floor, not a target: CI fails if coverage drops below this. Baseline
      // (2026-08-27, locally, fully deterministic across repeated runs):
      // ~70.7% stmts/lines, ~81% branch, ~72% funcs.
      //
      // The margin below that baseline has to be wider than it looks like it
      // should be. index.ts's escalation/cooldown paths branch on real
      // Date.now() comparisons (recordStreamFailure / hard-cooldown timing),
      // and are not deterministic under GitHub Actions' shared/variable-load
      // runners the way they are on an idle local machine — confirmed via a
      // job 250 investigation: identical code + identical 496-test suite,
      // fully reproducible/deterministic across repeated local runs (0-line
      // coverage diff, including under artificially constrained fork/thread
      // counts), still produced a genuine index.ts coverage swing in CI
      // (43.7% to 56.3% between two consecutive runs on the same commit
      // range) with every individual test passing both times. That's real
      // measured CI-only variance, not local flakiness we failed to catch.
      //
      // A fully deterministic fix would mean injecting a fake clock through
      // every cooldown/escalation code path so tests can force each branch
      // regardless of real elapsed time -- a large refactor of core routing
      // logic, out of proportion to what's actually a occasionally-flaky CI
      // gate rather than an incorrect behavior. Ratchet these up if a wider
      // deterministic-clock refactor happens later; don't shave them back
      // down just to silence one flaky run without new evidence the real
      // variance has shrunk.
      thresholds: {
        statements: 63,
        branches: 76,
        functions: 63,
        lines: 63,
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
