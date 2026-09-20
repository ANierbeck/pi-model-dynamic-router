/**
 * Regression test for the mistral-zai ghost-model incident (2026-09-20).
 *
 * registerGroupModels used to re-register every stale scan-cache entry of a
 * shadowed ALIAS provider (mistral-zai → mistral via pricingAlias) into
 * Pi's registry on EVERY session start — as long as the old API key was
 * still in Pi's credential store, getApiKeyForProvider('mistral-zai')
 * returned it and the ghosts came back with cost_per_m: 0 scan PLACEHOLDERS
 * baked in as real prices. Combined with the ghosts' best-in-pool GDPval,
 * they won every cost-sorted group ($0.0 + 1645) and broke the turn at
 * stream time ("not registered in Pi's model registry" / real money billed
 * upstream via the alias key).
 *
 * The fix (generic per Leitplanke 1, no hardcoded provider names): a
 * provider whose `pricingAlias` target is served by pi's own registry is a
 * REDUNDANT DUPLICATE — pi's catalog is the source of truth (real prices,
 * compat flags). Such providers must never be registered.
 *
 * This test exercises the live registration path end-to-end:
 *   1. pi knows `mistral` → mistral-zai must NOT be registered, even though
 *      an API key IS available for it (the key's existence is exactly what
 *      resurrected the ghosts before the fix).
 *   2. pi does NOT know `mistral` → mistral-zai (own key) is the only route
 *      to those models and MUST still be registered (non-regression for
 *      the alias-without-target case).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireRouterStateLock,
  releaseRouterStateLock,
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/router-state-lock.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dynamicConfigPath = path.join(repoRoot, 'router-config.dynamic.json');
const scanCachePath = path.join(repoRoot, '.cache', 'scan-cache.json');

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  fn: (defaultExport: any, tmpDir: string) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ghost-purge-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.ghost-purge-bak`;
  const cacheBak = `${scanCachePath}.ghost-purge-bak`;
  await acquireRouterStateLock();
  const hadDyn = fs.existsSync(dynamicConfigPath);
  const hadCache = fs.existsSync(scanCachePath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  if (hadCache) fs.renameSync(scanCachePath, cacheBak);

  // Seed the scan cache with mistral-zai ghost entries (stale entries of a
  // provider whose config keys are long gone — exactly the incident state)
  // plus a real mistral entry, with a FRESH timestamp so the background
  // scan early-returns at every gate (no network in tests).
  fs.writeFileSync(
    scanCachePath,
    JSON.stringify({
      available_models: [
        { id: 'zai-glm-5-3', provider: 'mistral-zai', cost_per_m: 0 },
        { id: 'zai-glm-5-2', provider: 'mistral-zai', cost_per_m: 0 },
        { id: 'mistral-medium-3.5', provider: 'mistral', cost_per_m: 0 },
      ],
      gdpval_scores: {},
      openrouter_pricing: {},
      lastScanTimestamp: new Date().toISOString(),
      gdpval_scraped: true,
      models_cached: new Date().toISOString(),
    })
  );

  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    await fn(mod.default as any, tmpDir);
  } finally {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
    removeNoOpScanCache(scanCachePath);
    if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    releaseRouterStateLock();
  }
}

interface SessionHooks {
  onHandlers: Record<string, (ev: any, ctx: any) => any>;
  registerProviderCalls: { name: string; opts: any }[];
  buildCtx: (knownProviders: Array<Record<string, unknown>>) => any;
}

function bootRouterWithMockPi(defaultExport: any, tmpDir: string): SessionHooks {
  const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
  const registerProviderCalls: { name: string; opts: any }[] = [];
  const pi: any = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerProvider: vi.fn((name: string, opts: any) => {
      registerProviderCalls.push({ name, opts });
    }),
    setModel: vi.fn(async () => true),
    on: vi.fn((event: string, handler: any) => {
      onHandlers[event] = handler;
    }),
  };
  defaultExport(pi);

  const buildCtx = (knownModels: Array<Record<string, unknown>>) => ({
    modelRegistry: {
      getAvailable: () => knownModels,
      getRegisteredProviderIds: () => [] as string[],
      find: (provider: string, modelId: string) =>
        knownModels.find((m: any) => m.provider === provider && m.id === modelId) ?? null,
      // The key is available for BOTH providers — its existence for
      // mistral-zai is exactly what resurrected the ghosts before the fix.
      getApiKeyForProvider: async (provider: string) => `key-for-${provider}`,
      runtime: { streamSimple: vi.fn() },
    },
    cwd: tmpDir,
    ui: { setFooter: vi.fn() },
  });
  return { onHandlers, registerProviderCalls, buildCtx };
}

const MISTRAL_MODEL = {
  provider: 'mistral',
  id: 'mistral-medium-3.5',
  api: 'openai-completions',
  contextWindow: 128_000,
  cost: { input: 0.4, output: 1.2, cacheRead: 0.04, cacheWrite: 0 },
};

describe('registerGroupModels: alias-shadow rule (mistral-zai → mistral)', () => {
  it('does NOT register a shadowed alias provider when pi serves its pricingAlias target', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: {},
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      },
      async (defaultExport, tmpDir) => {
        const { onHandlers, registerProviderCalls, buildCtx } = bootRouterWithMockPi(
          defaultExport,
          tmpDir
        );
        // pi's own registry serves the `mistral` provider (real prices).
        const ctx = buildCtx([MISTRAL_MODEL]);
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const registeredProviders = registerProviderCalls.map((c) => c.name);
        expect(registeredProviders).not.toContain('mistral-zai');
      }
    );
  });

  it('STILL registers the alias provider when pi does not serve its target (own-key fallback preserved)', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: {},
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      },
      async (defaultExport, tmpDir) => {
        const { onHandlers, registerProviderCalls, buildCtx } = bootRouterWithMockPi(
          defaultExport,
          tmpDir
        );
        // pi knows NOTHING about mistral — the alias provider with its own
        // key is the only route to those models and must be registered.
        const ctx = buildCtx([]);
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const registeredProviders = registerProviderCalls.map((c) => c.name);
        expect(registeredProviders).toContain('mistral-zai');
      }
    );
  });
});
