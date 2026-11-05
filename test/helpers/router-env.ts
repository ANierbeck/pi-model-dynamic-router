// Shared isolated-router runner (Prettier round step 5,
// docs/plans/2026-11-05-prettier-formatting.md). ~15 test files spelled the
// same boot-and-teardown skeleton for "run the extension against a throwaway
// HOME": mkdtemp, .pi/router-config.json, a cwd spy, parked state files, a
// no-op scan cache, `vi.resetModules()` + a dynamic import of the extension,
// and a finally that undoes all of it. The skeleton is infrastructure, not a
// test body — it lives here once. Per-file extras hook in via options.
//
// The import path is relative to THIS file (../../index.ts); it resolves to
// the same module the tests used to import as '../index.ts'.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';
import { parkStateFiles, routerStatePaths } from './extension-harness.ts';
import {
  removeNoOpScanCache,
  removeNoOpScanCacheDefault,
  writeNoOpScanCache,
} from './noop-scan-cache.ts';

export interface RouterEnvOptions {
  /** Written to .pi/router-config.json. Default {} (the shipped defaults). */
  config?: Record<string, unknown>;
  /** mkdtemp prefix, so a leaked directory names its test. Default 'router-test-'. */
  tmpPrefix?: string;
  /**
   * State files parked away for the run and restored in the finally. Default:
   * the dynamic config and the scan cache (routerStatePaths()). Pass a
   * smaller list to park less, an empty list to park nothing.
   */
  parkState?: string[];
  /**
   * Write the no-op scan cache before the import (default true). Pass
   * `{ localModels: [...] }` for the seeded variant several tests use.
   */
  seedScanCache?: boolean | { localModels?: string[] };
  /** Runs after the set-up, before the module reset + import (fetch stubs, custom scan-cache seeds, extra spies). */
  beforeImport?: (tmpDir: string) => void;
  /** Runs in the finally, before the tmpDir removal and the state restore. */
  teardown?: (tmpDir: string) => void;
  /**
   * Stub globalThis.fetch to reject (hermetic tests: no real HTTP). The
   * original fetch is restored in the finally. Default false.
   */
  disableNetwork?: boolean | string;
}

/**
 * Boot the extension in a throwaway HOME and tear it down afterwards.
 * `fn` receives the freshly imported extension default export and the tmpDir.
 */

export async function withRouterEnv(
  fn: (defaultExport: any, tmpDir: string) => Promise<void>,
  options: RouterEnvOptions = {}
): Promise<void> {
  const {
    config = {},
    tmpPrefix = 'router-test-',
    parkState,
    seedScanCache = true,
    beforeImport,
    teardown,
    disableNetwork = false,
  } = options;
  const { dynamicConfigPath, scanCachePath } = routerStatePaths();
  const parked = parkState ?? [dynamicConfigPath, scanCachePath];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(config));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  const restoreState = parkStateFiles(parked);
  if (seedScanCache) {
    writeNoOpScanCache(scanCachePath, typeof seedScanCache === 'object' ? seedScanCache : {});
  }
  const originalFetch = globalThis.fetch;
  if (disableNetwork) {
    const msg =
      typeof disableNetwork === 'string' ? disableNetwork : 'network disabled during test';
    globalThis.fetch = (() => Promise.reject(new Error(msg))) as typeof fetch;
  }
  try {
    beforeImport?.(tmpDir);
    vi.resetModules();

    const mod: any = await import('../../index.ts');
    await fn(mod.default, tmpDir);
  } finally {
    cwdSpy.mockRestore();
    if (disableNetwork) globalThis.fetch = originalFetch;
    teardown?.(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreState();
    if (seedScanCache) removeNoOpScanCache(scanCachePath);
  }
}

/**
 * The throwaway-project part of the boot (files that hand-roll their setup
 * instead of withRouterEnv): mkdtemp + .pi/ + router-config.json + a cwd
 * spy. Returns everything the caller needs to undo it.
 */
export function bootProjectDir(
  config: Record<string, unknown>,
  tmpPrefix = 'router-test-'
): {
  tmpDir: string;

  cwdSpy: any;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(config));

  const cwdSpy: any = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  return { tmpDir, cwdSpy };
}

/**
 * Run fn with the dynamic config (router-config.dynamic.json) renamed away
 * for the duration, so a test can assert regeneration from scratch. The
 * scan cache is seeded with a no-op. Used by the hand-rolled runners that
 * still need their own import sequence.
 */
export async function withFreshDynamicConfig(
  fn: (mod: any) => Promise<void>,
  suffix = 'test-bak'
): Promise<void> {
  const { dynamicConfigPath, scanCachePath } = routerStatePaths();
  const dynBak = `${dynamicConfigPath}.${suffix}`;
  const hadDyn = fs.existsSync(dynamicConfigPath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  writeNoOpScanCache(scanCachePath);
  try {
    vi.resetModules();

    const mod: any = await import('../../index.ts');
    await fn(mod);
  } finally {
    removeNoOpScanCache(scanCachePath);
    if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
  }
}

/** Remove a bootProjectDir/withRouterEnv tmp dir (the afterEach/finally line ~15 files spelled out). */
export function rmTmpDir(tmpDir: string): void {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * The standard teardown after a hand-rolled boot: restore cwd, remove the
 * tmp dir, flush a possible late background-scan save (the race
 * flushBackgroundScan exists for), then remove the no-op scan cache.
 */
export async function teardownRouterEnv(cwdSpy: any, tmpDir: string): Promise<void> {
  const { scanCachePath } = routerStatePaths();
  cwdSpy.mockRestore();
  rmTmpDir(tmpDir);
  const { flushBackgroundScan } = await import('./noop-scan-cache.ts');
  await flushBackgroundScan();
  removeNoOpScanCache(scanCachePath);
}

interface TeardownBootOptions {
  cwdSpy: any;
  tmpDir: string;
  /** parkStateFiles restore fn, when the boot parked state. */
  restoreState?: () => void;
  /** dynamic-config restore: { bak, path, had } — renamed away during the run. */
  dynRestore?: { bak: string; path: string; had: boolean };
}

/** The standard teardown after a hand-rolled boot (mockRestore + rmTmpDir + restores + cache removal). */
export function teardownBoot(options: TeardownBootOptions): void {
  const { cwdSpy, tmpDir, restoreState, dynRestore } = options;
  cwdSpy.mockRestore();
  rmTmpDir(tmpDir);
  if (dynRestore?.had) fs.renameSync(dynRestore.bak, dynRestore.path);
  restoreState?.();
  removeNoOpScanCacheDefault();
}
