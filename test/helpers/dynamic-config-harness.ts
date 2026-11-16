// test/helpers/dynamic-config-harness.ts
// Shared harness for tests that drive a real session_start and inspect the
// generated snapshot (router-config.dynamic.json).
//
// Extracted 2026-11-16 (redundancy ratchet): two test files had grown their
// own near-identical copy of "write a scan cache, boot the extension, fire
// session_start". The duplication is the harness, not the assertions, so it
// belongs here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { writeScanCacheFixture } from './noop-scan-cache.ts';
import { rmTmpDir } from './router-env.ts';
import { makePiCtx } from './extension-harness.ts';

export interface HarnessModel {
  provider: string;
  id: string;
}

export interface StartRouterOptions {
  /** Extra/overriding fields for the scan-cache fixture. */
  cache?: Record<string, unknown>;
  /** A pre-existing snapshot that must survive (or be replaced). */
  existingDynamic?: unknown;
  /** Project-level `.pi/router-config.json` content. */
  projectConfig?: Record<string, unknown>;
  /** Registry models. Defaults to a single `healthy-provider/model-a`. */
  models?: HarnessModel[];
}

export interface StartedRouter {
  dynamicPath: string;
  cleanup: () => void;
}

/** Polls `check` until it holds or the budget runs out. */
export async function waitFor(check: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

/**
 * Writes a scan cache, boots the extension in a throwaway cwd with network
 * disabled, and fires `session_start`. The caller must invoke `cleanup()`.
 */
export async function startRouterWithScanCache(
  opts: StartRouterOptions = {}
): Promise<StartedRouter> {
  const stateDir = process.env.PI_ROUTER_STATE_DIR!;
  const dynamicPath = path.join(stateDir, 'router-config.dynamic.json');
  const cachePath = path.join(stateDir, '.cache', 'scan-cache.json');
  const models = opts.models ?? [{ provider: 'healthy-provider', id: 'model-a' }];
  fs.rmSync(dynamicPath, { force: true });
  if (opts.existingDynamic) {
    fs.writeFileSync(dynamicPath, JSON.stringify(opts.existingDynamic));
  }
  writeScanCacheFixture(cachePath, {
    gdpval_scraped: true,
    models_cached: new Date().toISOString(),
    available_models: models.map((m) => ({ ...m, cost_per_m: 0.1 })),
    gdpval_scores: Object.fromEntries(models.map((m) => [m.id, 800])),
    ...opts.cache,
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-dyn-harness-'));
  if (opts.projectConfig) {
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify(opts.projectConfig)
    );
  }
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as typeof fetch;
  try {
    vi.resetModules();
    const mod = await import('../../index.ts');
    const { pi, onHandlers } = makePiCtx();
    (mod.default as any)(pi);
    const registryModels = models.map((m) => ({
      provider: m.provider,
      id: m.id,
      api: 'openai-completions',
      contextWindow: 128_000,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
    }));
    const modelRegistry = {
      getAvailable: () => registryModels,
      find: (p: string, id: string) =>
        registryModels.find((m) => m.provider === p && m.id === id) ?? null,
      getApiKeyForProvider: async () => 'k',
      runtime: { streamSimple: vi.fn() },
    };
    await onHandlers['session_start']?.(
      {},
      { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } }
    );
    return {
      dynamicPath,
      cleanup: () => {
        cwdSpy.mockRestore();
        globalThis.fetch = originalFetch;
        rmTmpDir(tmpDir);
        fs.rmSync(dynamicPath, { force: true });
      },
    };
  } catch (e) {
    cwdSpy.mockRestore();
    globalThis.fetch = originalFetch;
    throw e;
  }
}
