// Regression test: the router extension's process exit handler (CostTracker
// cleanup) must register ONCE per process, not once per extension load.
//
// The signal handlers below it were deduped in the v1.6.0 review round
// (globalThis.__ROUTER_SIGNAL_CLEANUP__) against the esbuild double-bundle
// hazard, but the exit handler at index.ts:624 was left outside the guard.
// Every extension load adds another listener; the suite printed
// MaxListenersExceededWarning (11 exit listeners) once test files stacked up.
//
// Red evidence: two activations (fresh import each, simulating a second
// bundle) added TWO listeners against the unfixed code; the pin allows
// exactly one.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  writeNoOpScanCache,
  removeNoOpScanCache,
} from './helpers/noop-scan-cache.ts';

const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

function makeMockPi(): any {
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    setModel: vi.fn(async () => true),
    on: vi.fn(),
  };
}

describe('exit-listener dedupe', () => {
  it('registers the exit handler once across two extension loads', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-exit-dedupe-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({ model_groups: {}, providers: {}, gdpval_builtin: {} })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.exit-dedupe-bak`;
    const cacheBak = `${scanCachePath}.exit-dedupe-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);
    writeNoOpScanCache(scanCachePath);

    // Fresh-process state: the guard flag must be unset so the FIRST
    // activation registers, and the second must not re-register.
    const savedFlag = (globalThis as any).__ROUTER_SIGNAL_CLEANUP__;
    delete (globalThis as any).__ROUTER_SIGNAL_CLEANUP__;

    try {
      const before = process.listenerCount('exit');

      vi.resetModules();
      let mod = await import('../index.ts');
      mod.default(makeMockPi());
      expect(process.listenerCount('exit')).toBe(before + 1); // first load registers

      vi.resetModules();
      mod = await import('../index.ts');
      mod.default(makeMockPi());
      // Second load (double-bundle shape): must NOT add another listener.
      expect(process.listenerCount('exit')).toBe(before + 1);
    } finally {
      (globalThis as any).__ROUTER_SIGNAL_CLEANUP__ = savedFlag ?? true;
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
    }
  });
});
