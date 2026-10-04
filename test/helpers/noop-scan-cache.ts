// No-op scan-cache for driveStream tests.
//
// session_start fires scan() WITHOUT awaiting it. When the scan cache is not
// valid, scan() ends in generateDynamicConfig(), which writes
// router-config.dynamic.json and swaps the module-level cfg/router mid-test
// ("No available models for group 'standard'" flakes). A minimal fresh,
// already-scraped cache makes generateDynamicConfig() early-return, and
// stubbing global fetch makes scan()'s discovery block (gated independently
// by MODELS_TTL / missing providers) fail fast instead of hitting the network.
//
// Each test file has its own PI_ROUTER_STATE_DIR (test/setup/isolate-home.ts),
// so these files never touch the checkout and no cross-file lock is needed.
// writeNoOpScanCache backs up an existing cache at the path and
// removeNoOpScanCache restores it, so callers with or without their own
// backup dance stay safe.

import fs from 'node:fs';
import path from 'node:path';

const NOOP_CACHE_BACKUP_SUFFIX = '.noop-bak';
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
      // F8 (2026-09-02): isScanCacheValid() now rejects a fresh-but-EMPTY cache
      // (0 available_models) and forces a rescan. The no-op cache's purpose is
      // to make scan() early-return at every gate so it never reaches
      // generateDynamicConfig() and swaps the module-level config mid-test.
      // A single placeholder model satisfies the sanity check without
      // affecting routing (tests set up their own candidates via
      // router-config + modelRegistry stubs, not via available_models).
      available_models: [{ id: 'no-op-placeholder', provider: 'test', cost_per_m: 0 }],
      // No router-config.dynamic.json belongs to this fixture: without this,
      // the missing file would trigger a regeneration mid-test.
      dynamic_config_expected: false,
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
 * early-return gates), which persists to the same state-dir-relative
 * scan-cache.json (PI_ROUTER_STATE_DIR/.cache/scan-cache.json — a fresh
 * empty dir per test file via isolate-home.ts) that this helper
 * backs up/restores. With fetch stubbed to reject (writeNoOpScanCache),
 * scan() settles in a handful of
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
/**
 * Waits for the unawaited session_start scan() to settle, not for a fixed
 * guess of its duration. scan() may call saveCache() SEVERAL times (GDPval
 * block, discovery merge, and after the classifier-fallback probe) and may
 * also early-return without writing at all (rt.scanning guard) — so a single
 * mtime advance is not a completion signal, but QUIESCENCE is: poll the
 * cache file's mtime until it has been unchanged for QUIET_MS, with a total
 * budget. The old fixed 50 ms sleep lost the race under parallel-suite load
 * (~1 in 6 runs locally, caught as "No available models for group
 * 'standard'" — a late scan swapped the router state mid-test).
 *
 * Worst case per call is QUIET_MS + one poll interval (~225 ms), paid when
 * the cache file exists; if the file is missing, the call falls back to the
 * old short sleep. A scan still writing at budget end proceeds anyway
 * (fail-open, like the old sleep always did).
 */
export async function flushBackgroundScan(): Promise<void> {
  const QUIET_MS = 200;
  const BUDGET_MS = 2_000;
  const POLL_MS = 25;
  const cachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');
  let lastMtime: number;
  try {
    lastMtime = fs.statSync(cachePath).mtimeMs;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return;
  }
  const t0 = Date.now();
  let lastChange = t0;
  while (Date.now() - t0 < BUDGET_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    let m: number;
    try {
      m = fs.statSync(cachePath).mtimeMs;
    } catch {
      return; // scan-cache removed mid-test — nothing to wait for
    }
    if (m > lastMtime) {
      lastMtime = m;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= QUIET_MS) {
      return; // quiet — the scan settled
    }
  }
  // Budget elapsed: a scan is still writing (or the FS clock is coarse).
  // Proceed fail-open, as the old fixed sleep always did.
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
