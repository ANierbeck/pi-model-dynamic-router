# ADR-0015: Test architecture — regression-first suite, per-file state and home isolation

**Status**: Accepted (documented 2026-09-26). It describes the suite as it
is after the 2026-09-26 consolidation and isolation work (~900 tests in 102
files, CI green) and lists the remaining debt.

## Context

The suite grew from ~500 to 930 tests in about a month, mostly as
regression tests written directly after live incidents. Three structural
problems surfaced along the way:

- **Shared filesystem state.** `driveStream` tests exercise `index.ts`,
  which resolves `router-config.dynamic.json` and `.cache/scan-cache.json`
  relative to its own directory, i.e. the **real repo checkout**. Parallel
  vitest workers raced on renaming and restoring those files ("No
  available models for group …" flakes).
- **Developer home leaking into tests.** Tests read the real
  `~/.pi/agent/router-config.user.json` and `auth.json`, and wrote to the
  real `~/.pi/logs/router.log`. Local green masked a red CI for four
  pushes (ADR-0009).
- **Timing-dependent coverage.** `index.ts` cooldown/escalation branches
  compare real `Date.now()` values, so coverage varies between CI runs of
  the same commit.

## Decision Drivers

- A test must fail for the reason it names, and pass in CI exactly as it
  does locally.
- Regression tests must exercise the real fix (non-vacuous, see AGENTS.md
  §4). Removing a test must not remove coverage.
- Don't refactor core routing just to make tests convenient.

## Decision

1. **Regression-first, incident-named tests.** A fix ships with a test that
   fails without it. The file or describe name refers to the incident.
   Duplicates across files are merged, not skipped. The
   2026-09-20 and 2026-09-26 passes were verified by a per-statement
   coverage diff.
2. **Per-file router state directory** (since 2026-09-26). `index.ts` reads
   and writes `router-config.dynamic.json` and `.cache/scan-cache.json` in
   `PI_ROUTER_STATE_DIR` (default: the extension directory, unchanged in
   production). The test setup points it at a fresh temp directory per test
   file. Tests no longer touch the checkout, and the cross-process lock
   (`router-state-lock.ts`, an atomic `mkdir` mutex that serialized 26 files
   with 180 s waits and 200 s test timeouts) was removed together with the
   raised timeouts. Full suite: ~12 s → ~3.5 s wall clock, ~113 s → ~17 s
   test time. `test/helpers/noop-scan-cache.ts` still keeps the unawaited
   `session_start` scan from swapping the config mid-test.
3. **Home isolation** (`test/setup/home-root.ts` + `isolate-home.ts`). Each
   test file sees a fresh temp home via a `node:os` `homedir()` mock and
   matching `HOME`, next to its state directory. The root is removed in
   global teardown. Guarded by `test/home-isolation.test.ts`.
4. **Coverage is a floor, not a target.** The thresholds in
   `vitest.config.ts` (63/76/63/63) sit well below the measured ~80 %
   lines / ~84 % branches, because of the timing variance above.
5. **Real time windows are kept.** The slowest tests wait out real
   production cooldown windows. Shortening them with artificial delays was
   rejected (2026-09-20). A fake clock would need a refactor of core
   routing.
6. **CI result is checked after every push.** A push is not done while CI
   is running.

## Consequences / known debt

- Timing-dependent `index.ts` branches keep the coverage floor low until
  a fake clock is injected.
- Resolved on 2026-09-26: the shared-state lock and the checkout writes
  (see point 2).

Related: ADR-0009 (home leak incident).
