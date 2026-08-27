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
// Fix (part 1): after moving the real scan-cache aside, write a minimal
// "fresh, already-scraped" scan-cache in its place. lastScanTimestamp (now)
// makes isScanCacheValid() return true so generateDynamicConfig()
// early-returns, and gdpval_scraped=true skips the GDPval network scrape.
//
// That alone is NOT sufficient: scan()'s model-discovery block is gated
// independently by `age > MODELS_TTL || missingProviders` (index.ts), and
// this no-op cache satisfies neither — it has no `models_cached` (so age is
// Infinity) and an empty `available_models` (so `missingProviders` is true
// for any real provider, e.g. mistral/openrouter, that has keys configured
// outside the test's own tmp cwd config). Without part 2 below, the
// unawaited scan() still runs REAL network discovery against Ollama/Mistral/
// OpenRouter and then unconditionally calls saveCache() — which, like
// router-config.dynamic.json, resolves against index.ts's own extension
// directory, NOT the test's mocked cwd. On a machine where this checkout is
// itself the loaded Pi extension (dev-on-the-installed-copy), that write
// lands on the real, live scan-cache.json, silently overwriting production
// router state with a partial scan (GDPval-scrape skipped, only
// Ollama/whatever-provider-discovery succeeded) — observed in practice: a
// `vitest run` overwrote the real cache with a scan whose gdpval_scores were
// just the 6 locally-estimated Ollama entries, timestamped mid-test-run.
//
// Fix (part 2): stub global fetch for the duration so every network call
// inside scan() fails fast. Every fetch call site in scan() (GDPval scrape,
// chutes, openrouter, ollama /api/tags + /api/show, generic provider scans)
// is already wrapped in try/catch, so a rejected fetch makes the whole
// discovery block a harmless no-op: `models` stays empty, `available_models`
// is left untouched by the (skipped) merge, and the final saveCache() only
// persists the harmless stub shape instead of real discovery results. These
// helpers keep that dance in one place so all 9 lock-based tests stay in
// sync.

// Some callers already move the real scan-cache.json aside themselves
// before calling writeNoOpScanCache (their own hadCache/cacheBak dance).
// Others (context-overflow, register-group-providers-label,
// skip-failure-malus) call writeNoOpScanCache directly against the live
// path with no backup at all — removeNoOpScanCache then unconditionally
// unlinks it, permanently deleting whatever real scan-cache.json existed
// before the test ran (observed in practice: the file was gone entirely
// after a run mixed a backing-up test with a non-backing-up one). To make
// every call site safe regardless of which pattern it uses, the backup/
// restore now lives HERE: if a real file exists at the given path when
// writeNoOpScanCache runs, it's moved aside and restored by
// removeNoOpScanCache. Callers that already moved it away first are
// unaffected (this just finds nothing to back up).
const NOOP_CACHE_BACKUP_SUFFIX = '.router-state-lock.noop-bak';
let originalFetch: typeof fetch | undefined;

/**
 * Writes a minimal scan-cache.json AND stubs global fetch to reject, making
 * the unawaited session_start scan() a full no-op (see block comment above
 * for why the cache alone isn't enough). Call AFTER moving the real
 * scan-cache aside and BEFORE firing session_start. The caller is
 * responsible for undoing both (removeNoOpScanCache) in afterEach.
 */
export function writeNoOpScanCache(scanCachePath: string): void {
  const backupPath = `${scanCachePath}${NOOP_CACHE_BACKUP_SUFFIX}`;
  if (fs.existsSync(scanCachePath)) fs.renameSync(scanCachePath, backupPath);

  fs.mkdirSync(path.dirname(scanCachePath), { recursive: true });
  fs.writeFileSync(
    scanCachePath,
    JSON.stringify({
      lastScanTimestamp: Date.now(),
      gdpval_scraped: true,
      models_cached: new Date().toISOString(),
      available_models: [],
      gdpval_scores: {},
    })
  );

  originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(new Error('network disabled during test (writeNoOpScanCache)'))) as typeof fetch;
}

/**
 * Awaits the unawaited background scan() fired by session_start.
 *
 * session_start calls `scan().catch(() => {})` WITHOUT awaiting it, so
 * `await onHandlers['session_start']?.(...)` in a test does NOT wait for
 * scan() to finish — only for the synchronous rest of the handler. scan()
 * ALWAYS ends with an unconditional `saveCache()` (outside any of its
 * early-return gates), which persists to the same extension-directory-
 * relative scan-cache.json this helper backs up/restores. With fetch
 * stubbed to reject (writeNoOpScanCache), scan() settles in a handful of
 * microtask ticks — but "a handful of ticks" is still nondeterministic
 * relative to a test's own cleanup. Call this right after firing
 * session_start so scan()'s harmless (stub-derived) saveCache() write lands
 * BEFORE the test's own restore, instead of racing to land after it and
 * clobbering the just-restored real cache (observed in practice with
 * context-overflow.test.ts: the real cache was replaced by the no-op stub's
 * shape even though writeNoOpScanCache/removeNoOpScanCache's backup/restore
 * ran correctly — the restore simply lost the race to a late scan()).
 * 50ms is generous headroom over the handful of ticks actually needed.
 */
export async function flushBackgroundScan(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Removes the no-op scan-cache, restores whatever real scan-cache.json
 * writeNoOpScanCache found and backed up (if any), and restores global
 * fetch. Safe to call even if the file is already gone or fetch was never
 * stubbed.
 */
export function removeNoOpScanCache(scanCachePath: string): void {
  try {
    fs.unlinkSync(scanCachePath);
  } catch {
    /* already gone */
  }
  const backupPath = `${scanCachePath}${NOOP_CACHE_BACKUP_SUFFIX}`;
  if (fs.existsSync(backupPath)) fs.renameSync(backupPath, scanCachePath);
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
}
