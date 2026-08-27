// Several test files back up and restore the same physical,
// repo-root-relative router-config.dynamic.json and .cache/scan-cache.json.
// Both paths are resolved from index.ts's own directory (extDir), not from
// any per-test cwd mock, so they're global state shared by every vitest
// worker process running these files concurrently. Without serializing
// access, two workers racing to rename/restore the same path can throw
// ENOENT (source already moved by the other worker) or hand each other a
// transiently wrong/missing file mid-test — producing "No available models
// for group ..." or similar spurious failures that have nothing to do with
// the code under test.
//
// This is a cross-process mutex built on the one truly atomic filesystem
// primitive Node exposes portably: mkdir fails with EEXIST if the directory
// already exists, and that check-and-create is atomic at the OS level.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_DIR = path.join(os.tmpdir(), 'pi-router-test-shared-state.lock');

// A lock dir older than this was almost certainly left behind by a run that
// got killed between acquire and release (Ctrl-C, CI timeout, OOM) rather
// than a legitimately slow holder — no single test body here runs anywhere
// near this long. Treat it as abandoned and reclaim it instead of making
// every future run pay the full acquire timeout.
const STALE_LOCK_MS = 5 * 60_000;

let holdingLock = false;

/**
 * Blocks until the shared-state lock is held by this test.
 *
 * Default timeout: 9 test files currently serialize on this lock, and their
 * individual hold times (measured locally: ~1s-10.9s each, dominated by
 * tests that intentionally wait out real setTimeout-based timeouts) sum to
 * roughly 55-60s in the worst case where all 9 happen to queue back-to-back
 * on the same CI runner. GitHub Actions' shared/throttled CPUs regularly run
 * 2-3x slower than an idle local machine, so a 60s timeout here had no
 * headroom left and intermittently threw under CI's real-world scheduling
 * ("No available models for group ...", CI runs 33061592936, retried and
 * reproduced on a *different* lock-using file each time -- confirming
 * genuine multi-file contention, not a bug isolated to one file). Widened to
 * 180s to comfortably absorb that worst case; vitest's testTimeout/
 * hookTimeout (vitest.config.ts) must stay comfortably above this value or
 * vitest kills the wait before this timeout ever gets a chance.
 */
export async function acquireRouterStateLock(timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      holdingLock = true;
      return;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const { mtimeMs } = fs.statSync(LOCK_DIR);
        if (Date.now() - mtimeMs > STALE_LOCK_MS) {
          fs.rmdirSync(LOCK_DIR);
          continue;
        }
      } catch {
        continue; // lock vanished between the failed mkdir and this stat — retry immediately
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for router test state lock at ${LOCK_DIR}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Releases the shared-state lock. Safe to call even if not currently held. */
export function releaseRouterStateLock(): void {
  holdingLock = false;
  try {
    fs.rmdirSync(LOCK_DIR);
  } catch {
    /* already released, or never acquired */
  }
}

// Best-effort cleanup so a killed test run doesn't leave a lock that every
// future run has to wait out or manually delete.
function releaseOnExit(): void {
  if (holdingLock) releaseRouterStateLock();
}
process.once('exit', releaseOnExit);
process.once('SIGINT', () => {
  releaseOnExit();
  process.exit(130);
});
process.once('SIGTERM', () => {
  releaseOnExit();
  process.exit(143);
});

/**
 * Runs `fn` with exclusive access to the shared router-config.dynamic.json /
 * .cache/scan-cache.json files. Any test that moves those paths aside and
 * restores them must wrap the whole move-aside/run/restore span in this (or
 * the acquire/release pair above for beforeEach/afterEach-style setups), so
 * concurrent test files can't race on the same physical file.
 */
export async function withSharedRouterStateLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireRouterStateLock();
  try {
    return await fn();
  } finally {
    releaseRouterStateLock();
  }
}

// ── No-op scan-cache (prevents the session_start scan() race) ──────────────
//
// The driveStream regression tests move the real scan-cache.json aside so
// cached machine-local scores don't leak in. But that leaves an EMPTY cache,
// and session_start fires scan() WITHOUT awaiting it. scan() ends by calling
// generateDynamicConfig(), which — when cacheManager.isScanCacheValid() is
// false (no lastScanTimestamp) — WRITES router-config.dynamic.json and swaps
// the module-level cfg/router to a dynamic config built from the scan. That
// swap races the test's groupStream() call and intermittently replaces the
// staticCfg-based router the test relies on, producing the CI-only
// "No available models for group 'standard'" flake (the dynamic config's
// real min_gdpval threshold filters out the test's unscored fake models).
//
// Fix: after moving the real scan-cache aside, write a minimal "fresh,
// already-scraped" scan-cache in its place. lastScanTimestamp (now) makes
// isScanCacheValid() return true so generateDynamicConfig() early-returns,
// and gdpval_scraped=true skips the GDPval network scrape. scan() becomes a
// no-op and can no longer swap global state mid-test. These helpers keep
// that 10-line dance in one place so all 9 lock-based tests stay in sync.

/**
 * Writes a minimal scan-cache.json that makes the unawaited session_start
 * scan() a no-op (fresh lastScanTimestamp + gdpval_scraped). Call AFTER
 * moving the real scan-cache aside and BEFORE firing session_start. The
 * caller is responsible for removing this file (removeNoOpScanCache) and
 * restoring the real one in afterEach.
 */
export function writeNoOpScanCache(scanCachePath: string): void {
  fs.mkdirSync(path.dirname(scanCachePath), { recursive: true });
  fs.writeFileSync(
    scanCachePath,
    JSON.stringify({
      lastScanTimestamp: Date.now(),
      gdpval_scraped: true,
      available_models: [],
      gdpval_scores: {},
    })
  );
}

/**
 * Removes the no-op scan-cache written by writeNoOpScanCache. Safe to call
 * even if the file is already gone (e.g. another helper removed it).
 */
export function removeNoOpScanCache(scanCachePath: string): void {
  try {
    fs.unlinkSync(scanCachePath);
  } catch {
    /* already gone */
  }
}
