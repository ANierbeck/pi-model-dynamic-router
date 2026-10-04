/**
 * Regression test for ADR-0021 (the router never registers models Pi does
 * not know).
 *
 * Root cause this pins: the scan-union (F4, 2026-09-02) registered
 * scan-discovered models into Pi's registry with PROVIDER_MAP's
 * `api: 'openai-completions'`. For mistral alone that added 29 models Pi's
 * builtin catalog does not ship — including OCR (mistral-ocr-*) and audio
 * (voxtral-mini-*) models registered as CHAT models. The Mistral 422
 * "store" rejections (ministral-*-2512 classifier-probe failures) were that
 * wrong-API registration failing at request time.
 *
 * ADR-0021 removed the registration entirely. Two invariants must hold:
 *   1. registerGroupModels never calls pi.registerProvider for a PROVIDER_MAP
 *      (cloud) provider — scan data must not create registrations. The only
 *      remaining registerProvider calls are the router's own virtual group
 *      providers (registerGroupProviders) and, kept by decision, the local
 *      Ollama block.
 *   2. Scan-discovered refs Pi cannot resolve never reach the generated
 *      snapshot: the streamability filter (2026-09-20 ghost-model incident)
 *      drops them, so no group's models array may contain an unregistered
 *      ref even when the scan cache still lists it (stale entries persist
 *      for unscanned providers — exactly how the 29 mistral ghosts stayed
 *      routable).
 *
 * This file replaces test/register-union-preserves-non-chat-models.test.ts
 * and test/register-group-models-merge-not-replace.test.ts, which pinned the
 * union round-trip (Ü1 / roborev 425/426/649 / ADR-0019) — machinery that
 * existed only to make the now-removed re-registration safe.
 *
 * Note on red/green: invariant 1 was RED before the fix (the union
 * registered mistral-zai) and is the load-bearing regression pin. Invariant
 * 2 (snapshot purity) passed before the fix too — by design: it pins the
 * 2026-09-20 streamability filter, which only ever worked because the TEST
 * registry refuses the unknown ref. In the live system the union's
 * registerProvider made `find()` succeed for scan-only refs, which is
 * exactly what invariant 1 now forbids.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeNoOpScanCache, flushBackgroundScan } from './helpers/noop-scan-cache.ts';

const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  scanModels: Array<Record<string, unknown>>,
  fn: (defaultExport: any, tmpDir: string) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-adr-0021-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  // Hermetic + fast (ADR-0022): with keys resolved by Pi, the LLM matcher's
  // free-cloud fallback is eligible whenever the registry stub returns a
  // key — so it attempts real HTTP calls. Stub fetch to reject so the
  // matcher fails fast instead of hitting the network (and so the dynamic
  // snapshot lands well before the assertions).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(new Error('network disabled during test (adr-0021)'))) as typeof fetch;

  const dynBak = `${dynamicConfigPath}.adr-0021-bak`;
  const cacheBak = `${scanCachePath}.adr-0021-bak`;
  const hadDyn = fs.existsSync(dynamicConfigPath);
  const hadCache = fs.existsSync(scanCachePath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  if (hadCache) fs.renameSync(scanCachePath, cacheBak);

  // lastScanTimestamp 0 = expired cache, so the background scan regenerates
  // router-config.dynamic.json (the snapshot assertions need that). The
  // gdpval/model-score fixtures below make both refs scoreable so the
  // snapshot builder neither drops the known ref as unscored nor needs the
  // LLM matcher (populateLlmMatches early-returns when nothing is unscored).
  fs.writeFileSync(
    scanCachePath,
    JSON.stringify({
      available_models: scanModels,
      // ref → slug resolution so lookupGdp finds a score without the LLM.
      model_score_cache: {
        'mistral-zai/zai-glm-5-2': 'glm-5-2',
        'mistral-zai/glm-5-2': 'glm-5-2',
      },
      gdpval_scores: { 'glm-5-2': 1497 },
      openrouter_pricing: {},
      lastScanTimestamp: 0,
      // Hermetic fixtures (roborev review round): without gdpval_scraped the
      // background scan scrapes GDPval from the network; without
      // models_cached it re-fetches model inventories.
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
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
    removeNoOpScanCache(scanCachePath);
    if (hadCache) fs.renameSync(cacheBak, scanCachePath);
  }
}

/** pi-known chat model the scan also reports. */
const knownChat = {
  id: 'zai-glm-5-2',
  name: 'mistral-zai/zai-glm-5-2',
  provider: 'mistral-zai',
  api: 'openai-completions',
  baseUrl: 'https://api.mistral.ai/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_000,
  compat: { supportsStore: false },
};

/**
 * Scan-cache entries: the pi-known model PLUS a variant Pi does NOT know
 * (the exact ministral-*-2512 shape that caused the 422s — a scan-discovered
 * dated variant absent from Pi's catalog). The unknown one even scores the
 * SAME gdpval, so if it leaked past the streamability filter it would be
 * indistinguishable from the known one in the group.
 */
const scanModels = [
  { id: 'zai-glm-5-2', provider: 'mistral-zai', cost_per_m: 0, capabilities: { reasoning: true } },
  { id: 'glm-5-2', provider: 'mistral-zai', cost_per_m: 0, capabilities: { reasoning: true } },
];

describe('ADR-0021: the router never registers models Pi does not know', () => {
  it('never calls registerProvider for a PROVIDER_MAP provider, even when the scan reports models Pi does not know', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: {
          'mistral-zai': { keys: [{ key: 'test-key' }] },
        },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      },
      scanModels,
      async (defaultExport, tmpDir) => {
        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const registerProviderCalls: any[] = [];
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

        // REAL 0.99.1 ModelRegistry contract (pi-ai dist/models.js:572):
        // getAll() is CHAT-ONLY; non-chat inventory comes from
        // getModelsOfType/findOfType. Pi knows ONLY the zai-glm-5-2 chat
        // model — glm-5-2 is exactly the kind of scan-discovered model the
        // old union would have registered.
        const nonChat: any[] = [];
        const modelRegistry = {
          getAll: () => [knownChat],
          getModelsOfType: (type: string, provider?: string) =>
            nonChat.filter(
              (m: any) => m.type === type && (!provider || m.provider === provider)
            ),
          findOfType: (type: string, provider: string, modelId: string) =>
            nonChat.find(
              (m: any) => m.type === type && m.provider === provider && m.id === modelId
            ) ?? null,
          getAvailable: () => [knownChat],
          find: (provider: string, modelId: string) =>
            provider === 'mistral-zai' && modelId === 'zai-glm-5-2' ? knownChat : null,
          getApiKeyForProvider: async () => 'test-key',
          runtime: { streamSimple: vi.fn() },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        // INVARIANT 1: no registration of scan-discovered models. The old
        // union registered mistral-zai here (with glm-5-2 added and the
        // pi-known models round-tripped); ADR-0021 removes that call. The
        // router's own virtual group providers MAY register (that is the
        // product surface), so assert on the provider name.
        const cloudRegistrations = registerProviderCalls.filter(
          (c) => c.name === 'mistral-zai' || c.name === 'mistral'
        );
        expect(cloudRegistrations).toEqual([]);
      }
    );
  });

  it('drops scan-discovered refs Pi cannot resolve from the generated group config', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: {
          'mistral-zai': { keys: [{ key: 'test-key' }] },
        },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      },
      scanModels,
      async (defaultExport, tmpDir) => {
        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => {
            onHandlers[event] = handler;
          }),
        };
        defaultExport(pi);

        const modelRegistry = {
          getAll: () => [knownChat],
          getModelsOfType: () => [],
          findOfType: () => null,
          getAvailable: () => [knownChat],
          find: (provider: string, modelId: string) =>
            provider === 'mistral-zai' && modelId === 'zai-glm-5-2' ? knownChat : null,
          getApiKeyForProvider: async () => 'test-key',
          runtime: { streamSimple: vi.fn() },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        // INVARIANT 2: the snapshot exists, the pi-known ref is a routing
        // candidate, and the unresolvable scan ref never made it in — even
        // though it sat in the scan cache with an equal gdpval score.
        expect(fs.existsSync(dynamicConfigPath)).toBe(true);
        const dynamic = JSON.parse(fs.readFileSync(dynamicConfigPath, 'utf-8'));
        const standardModels: string[] = dynamic.model_groups?.standard?.models ?? [];
        expect(standardModels).toContain('mistral-zai/zai-glm-5-2');
        expect(standardModels).not.toContain('mistral-zai/glm-5-2');
      }
    );
  });
});
