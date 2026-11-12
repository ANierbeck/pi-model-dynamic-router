# Upstream attribution: which files carry original `pi-model-router` code

This repository began as a fork of `a-canary/pi-model-router` (MIT). The MIT
licence requires the original copyright notice to stay with every copy or
substantial portion of the original code. Everything else is new work.

- **Listed below:** the file still contains code of the original. Its notice
  names both `a-canary` and Achim Nierbeck (see `LICENSE`).
- **Not listed:** the file contains no original code. Copyright is Achim
  Nierbeck's alone.

## Files that still contain original code

<!-- upstream-files:start -->
- `PI.md`
- `README.md`
- `index.ts`
- `model-map.yaml`
- `package.json`
- `router-defaults.yaml`
- `skills/router-login/SKILL.md`
- `src/cache.ts`
- `src/commands.ts`
- `src/event-handlers.ts`
- `src/group-registration.ts`
- `src/limit-glue.ts`
- `src/metrics.ts`
- `src/model-resolve-glue.ts`
- `src/routing.ts`
- `src/scan-runner.ts`
- `src/stream-orchestrator.ts`
- `src/stream-proxy.ts`
- `src/tools.ts`
- `src/types.ts`
- `src/utils.ts`
<!-- upstream-files:end -->

## How the list was made

Measured 2026-11-12 against the fork point `039d60f` (the last upstream
commit). Method and numbers: `docs/research/2026-11-12-fork-remainder-measurement.md`.
Two signals, because a reformat (the one-time Prettier run) hides lines from
`git blame` while leaving the code intact:

1. `git blame -C -C -C` lines still attributed to an upstream commit that carry
   content (at least three alphanumeric characters).
2. Token windows: runs of 20 tokens (quotes and `;` `,` normalised) that occur
   in the upstream files at `039d60f`, with at least ten word tokens per window
   so that decoration lines and empty objects do not count.

A file is listed when it has at least 50 tokens covered by (2) or at least four
lines from (1). Control files written entirely after the fork score at most
0.4 % on (2). Excluded as non-copyrightable boilerplate: standard `.gitignore`
lines, the all-zero `usage` object in `src/stream-driver.ts`, the shared
imports in the spike and isolation-test files.

## Keeping it right

- Rewriting a listed file until no original code is left removes it from the
  list; do that only after re-measuring, never by assumption.
- A new file never goes on the list unless it copies original code.
- `test/upstream-attribution.test.ts` checks that the list parses, every entry
  exists, and `LICENSE` carries the matching two clauses.
