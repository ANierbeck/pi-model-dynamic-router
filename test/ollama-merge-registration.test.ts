/**
 * Ollama merge registration (bug fix, 2026-10-02 — owner decision on the
 * guard defect found during the ADR-0021 investigation).
 *
 * The pre-fix guard compared TAGGED scan ids (`gemma4:latest`) against
 * UNTAGGED models.json ids (`gemma4`) with exact `find()`, so it never
 * matched and the router re-registered Ollama on EVERY session_start
 * (83× in the live log) — wiping the user's models.json registration
 * (applyExtension drops models.json entries whenever the extension
 * overlay defines `models`, ADR-0019).
 *
 * The fix: merge instead of replace.
 *   - Pi-known Ollama models (models.json / prior registration) are
 *     round-tripped AS-IS with their typed fields and WIN the
 *     normalized-id dedup (`gemma4` ≡ `gemma4:latest`; tagged variants
 *     like `gemma4:12b-mlx` stay distinct and are added).
 *   - Scan-only models are ADDED with real contextWindow and
 *     providerOptions.num_ctx metadata from /api/show capabilities (this
 *     is the only source of the user's classifier models, e.g.
 *     `mistral-nemo:latest`). Note (roborev 719): pi-ai 1.0.0 never reads
 *     a model-level providerOptions at request time — num_ctx is
 *     forward-compat metadata; contextWindow is the load-bearing field.
 *   - If the registry already knows every scanned model, NO registration
 *     happens at all (idempotent — models.json stays the sole overlay).
 *
 * Tests 1–3 are RED before the fix (the pre-fix guard registered
 * scan-only models and wiped the registry entries); test 4 pins the
 * AS-IS round-trip (the enrichment branch from the first fix iteration
 * was dropped after roborev 719 found model-level providerOptions inert
 * in pi-ai 1.0.0); test 5 pins that user-set providerOptions WIN over
 * scan twin enrichment (never clobbered); tests 6–7 pin the empty-registry
 * branch and the two-session idempotency (the 83× invariant end-to-end);
 * test 8 pins the getAll()-less find() fallback (superpowers reviewer
 * finding: the d304304 hardening had zero coverage).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeNoOpScanCache, flushBackgroundScan } from './helpers/noop-scan-cache.ts';

const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

async function withIsolatedRouter(
  registryModels: any[],
  scanModels: Array<Record<string, unknown>>,
  opts: { omitGetAll?: boolean },
  fn: (
    defaultExport: any,
    tmpDir: string,
    registerProviderCalls: any[],
    fireSessionStart: (registryModels: any[]) => Promise<void>
  ) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ollama-merge-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify({}));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.ollama-merge-bak`;
  const cacheBak = `${scanCachePath}.ollama-merge-bak`;
  const hadDyn = fs.existsSync(dynamicConfigPath);
  const hadCache = fs.existsSync(scanCachePath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  if (hadCache) fs.renameSync(scanCachePath, cacheBak);

  fs.writeFileSync(
    scanCachePath,
    JSON.stringify({
      available_models: scanModels,
      model_score_cache: {},
      gdpval_scores: {},
      openrouter_pricing: {},
      lastScanTimestamp: Date.now(),
      gdpval_scraped: true,
      models_cached: new Date().toISOString(),
      // dynamic_config_expected: false keeps the background scan from
      // regenerating the snapshot — these tests only pin the registration.
      dynamic_config_expected: false,
    })
  );

  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    const registerProviderCalls: any[] = [];
    const pi: any = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerProvider: vi.fn((name: string, opts: any) => {
        registerProviderCalls.push({ name, opts });
      }),
      setModel: vi.fn(async () => true),
      on: vi.fn((event: string, handler: any) => {
        (pi as any)._handlers[event] = handler;
      }),
      _handlers: {} as Record<string, (ev: any, ctx: any) => any>,
    };
    mod.default(pi);

    const makeRegistry = (models: any[]) => ({
      // omitGetAll: exercise the find() fallback path (hosts without
      // getAll()) that d304304 hardened — see the last test.
      ...(opts.omitGetAll ? {} : { getAll: () => models }),
      getModelsOfType: () => [],
      findOfType: () => null,
      getAvailable: () => models,
      find: (provider: string, modelId: string) =>
        models.find((m: any) => m.provider === provider && m.id === modelId) ?? null,
      getApiKeyForProvider: async () => 'test-key',
      runtime: { streamSimple: vi.fn() },
    });
    const ctx: any = {
      modelRegistry: makeRegistry(registryModels),
      cwd: tmpDir,
      ui: { setFooter: vi.fn() },
    };
    const fireSessionStart = async (nextRegistryModels: any[]) => {
      ctx.modelRegistry = makeRegistry(nextRegistryModels);
      await pi._handlers['session_start']?.({}, ctx);
    };
    await fireSessionStart(registryModels);
    await flushBackgroundScan();
    await fn(mod.default as any, tmpDir, registerProviderCalls, fireSessionStart);
  } finally {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
    removeNoOpScanCache(scanCachePath);
    if (hadCache) fs.renameSync(cacheBak, scanCachePath);
  }
}

/** models.json-shaped registry entries (UNTAGGED ids, typed fields). */
const gemma4Registry = {
  id: 'gemma4',
  name: 'ollama/gemma4',
  provider: 'ollama',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131_072,
  maxTokens: 8_192,
};
const qwen35Registry = {
  id: 'qwen3.5',
  name: 'ollama/qwen3.5',
  provider: 'ollama',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_144,
  maxTokens: 8_192,
};

/** The live incident shape: tagged scan ids vs untagged models.json ids. */
const incidentScanModels = [
  { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 131_072, vision: true } },
  { id: 'qwen3.5:latest', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 262_144 } },
  // Scan-only models — NOT in models.json. This is the only source of the
  // user's classifier models, so they must be ADDED, not lost.
  { id: 'mistral-nemo:latest', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 131_072 } },
  { id: 'gemma2:2b', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 8_192 } },
];

describe('Ollama merge registration (guard fix: tagged scan ids vs untagged models.json ids)', () => {
  it('merges: keeps registry (models.json) models, adds scan-only models — never wipes', async () => {
    await withIsolatedRouter(
      [gemma4Registry, qwen35Registry],
      incidentScanModels,
      {},
      async (_defaultExport, _tmpDir, registerProviderCalls) => {
        const ollamaCalls = registerProviderCalls.filter((c) => c.name === 'ollama');
        expect(ollamaCalls.length).toBe(1);
        const models: any[] = ollamaCalls[0].opts.models;

        // Registry models survive with their typed fields (pre-fix: wiped).
        const gemma4 = models.find((m) => m.id === 'gemma4');
        expect(gemma4).toBeDefined();
        expect(gemma4.input).toEqual(['text', 'image']);
        expect(gemma4.contextWindow).toBe(131_072);
        const qwen35 = models.find((m) => m.id === 'qwen3.5');
        expect(qwen35).toBeDefined();
        expect(qwen35.contextWindow).toBe(262_144);

        // Scan-only models are added (pre-fix they replaced everything).
        const nemo = models.find((m) => m.id === 'mistral-nemo:latest');
        expect(nemo).toBeDefined();
        expect(nemo.contextWindow).toBe(131_072);
        expect(nemo.providerOptions.num_ctx).toBe(131_072);

        // Normalized dedup: the scan's gemma4:latest must NOT add a second
        // gemma4 (pre-fix the tagged twin was the ONLY gemma4).
        expect(models.filter((m) => m.id.startsWith('gemma4'))).toHaveLength(1);
      }
    );
  });

  it('registers nothing when the registry already knows every scanned model (normalized)', async () => {
    await withIsolatedRouter(
      [gemma4Registry, qwen35Registry],
      [
        { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 131_072 } },
        { id: 'qwen3.5:latest', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 262_144 } },
      ],
      {},
      async (_defaultExport, _tmpDir, registerProviderCalls) => {
        // Pre-fix the guard never matched (tagged vs untagged) and
        // re-registered on every session. Post-fix: nothing new → no call.
        expect(registerProviderCalls.filter((c) => c.name === 'ollama')).toHaveLength(0);
      }
    );
  });

  it('keeps tagged variants distinct: gemma4:12b-mlx is added alongside registry gemma4', async () => {
    await withIsolatedRouter(
      [gemma4Registry],
      [
        { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 131_072 } },
        { id: 'gemma4:12b-mlx', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 131_072 } },
      ],
      {},
      async (_defaultExport, _tmpDir, registerProviderCalls) => {
        const ollamaCalls = registerProviderCalls.filter((c) => c.name === 'ollama');
        expect(ollamaCalls).toHaveLength(1);
        const models: any[] = ollamaCalls[0].opts.models;
        expect(models.find((m) => m.id === 'gemma4')).toBeDefined();
        expect(models.find((m) => m.id === 'gemma4:12b-mlx')).toBeDefined();
        // Only ONE untagged/`:latest` gemma4 twin — dedup collapsed them.
        expect(
          models.filter((m) => m.id === 'gemma4' || m.id === 'gemma4:latest')
        ).toHaveLength(1);
      }
    );
  });

  it('round-trips known models AS-IS: no providerOptions is fabricated for them', async () => {
    await withIsolatedRouter(
      [gemma4Registry, qwen35Registry],
      incidentScanModels,
      {},
      async (_defaultExport, _tmpDir, registerProviderCalls) => {
        const ollamaCalls = registerProviderCalls.filter((c) => c.name === 'ollama');
        expect(ollamaCalls).toHaveLength(1);
        const models: any[] = ollamaCalls[0].opts.models;
        // The first fix iteration enriched gemma4 (no providerOptions)
        // with num_ctx from its scan twin. Roborev 719 verified pi-ai
        // 1.0.0 never reads a model-level providerOptions at request
        // time — inert metadata — so the enrichment was dropped: known
        // models are round-tripped exactly as the user defined them.
        const gemma4 = models.find((m) => m.id === 'gemma4');
        expect(gemma4.providerOptions).toBeUndefined();
      }
    );
  });

  it('preserves user-set providerOptions (never overwrites with scan twin enrichment)', async () => {
    const userSetModel = {
      ...gemma4Registry,
      providerOptions: { num_ctx: 9999 }, // User explicitly set
    };
    await withIsolatedRouter(
      [userSetModel],
      [
        { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 131_072 } },
        { id: 'mistral-nemo:latest', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 128_000 } },
      ],
      {},
      async (_defaultExport, _tmpDir, registerProviderCalls) => {
        const ollamaCalls = registerProviderCalls.filter((c) => c.name === 'ollama');
        expect(ollamaCalls).toHaveLength(1); // Merge: gemma4 known, nemo new
        const models: any[] = ollamaCalls[0].opts.models;
        const gemma4 = models.find((m) => m.id === 'gemma4');
        // User value WINS, NOT 131_072 from scan capabilities — the
        // round-trip only copies providerOptions when present.
        expect(gemma4.providerOptions.num_ctx).toBe(9999);
      }
    );
  });

  it('empty registry branch: registers the whole scan inventory with real contextWindow + num_ctx metadata', async () => {
    await withIsolatedRouter(
      [], // Pi does not know Ollama at all (no models.json entry)
      incidentScanModels,
      {},
      async (_defaultExport, _tmpDir, registerProviderCalls) => {
        const ollamaCalls = registerProviderCalls.filter((c) => c.name === 'ollama');
        expect(ollamaCalls).toHaveLength(1);
        const models: any[] = ollamaCalls[0].opts.models;
        // Every scanned model is registered, each with its real
        // contextWindow (load-bearing) and num_ctx metadata from caps.
        expect(models).toHaveLength(incidentScanModels.length);
        for (const scan of incidentScanModels) {
          const m = models.find((x: any) => x.id === scan.id);
          expect(m).toBeDefined();
          expect(m.contextWindow).toBe((scan.capabilities as any).contextWindow);
          expect(m.providerOptions.num_ctx).toBe((scan.capabilities as any).contextWindow);
        }
      }
    );
  });

  it('is idempotent across two session_starts: the merged registration feeds back as the next registry', async () => {
    await withIsolatedRouter(
      [gemma4Registry],
      [
        { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 131_072 } },
        { id: 'mistral-nemo:latest', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 128_000 } },
      ],
      {},
      async (_defaultExport, _tmpDir, registerProviderCalls, fireSessionStart) => {
        // First session_start merged (gemma4 known, nemo new): 1 call.
        expect(registerProviderCalls.filter((c) => c.name === 'ollama')).toHaveLength(1);
        const firstModels: any[] = registerProviderCalls.find(
          (c) => c.name === 'ollama'
        ).opts.models;

        // What a second session_start (or /reload) in the SAME process
        // sees: getAll() now reports the merged list — registry feedback.
        await fireSessionStart(
          firstModels.map((m: any) => ({ ...m, provider: 'ollama' }))
        );

        // The 83× invariant: still exactly ONE registration in total.
        expect(registerProviderCalls.filter((c) => c.name === 'ollama')).toHaveLength(1);
      }
    );
  });

  it('getAll()-less registry: the find() fallback dedups via tagged+untagged probes', async () => {
    await withIsolatedRouter(
      [gemma4Registry],
      [
        { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 131_072 } },
        { id: 'mistral-nemo:latest', provider: 'ollama', cost_per_m: 0, capabilities: { contextWindow: 128_000 } },
      ],
      { omitGetAll: true }, // hosts without getAll(): fallback path
      async (_defaultExport, _tmpDir, registerProviderCalls) => {
        const ollamaCalls = registerProviderCalls.filter((c) => c.name === 'ollama');
        expect(ollamaCalls).toHaveLength(1); // gemma4 found via untagged probe, nemo new
        const models: any[] = ollamaCalls[0].opts.models;
        // The REGISTRY version wins the dedup (typed fields), not the
        // scan's flat tagged twin — no wipe, no duplicate.
        const gemma4 = models.find((m) => m.id === 'gemma4');
        expect(gemma4).toBeDefined();
        expect(gemma4.input).toEqual(['text', 'image']);
        expect(models.find((m) => m.id === 'mistral-nemo:latest')).toBeDefined();
        expect(models.filter((m) => m.id.startsWith('gemma4'))).toHaveLength(1);
      }
    );
  });
});
