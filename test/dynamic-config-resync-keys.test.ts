/**
 * Final v1.6.0 review findings I4 + I5 (Important): the dynamic-config
 * staleness whitelist in load() (and the parallel forced-keys list in
 * generateDynamicConfigNow's written file) was maintained as hand-written
 * assignment lines. ollama_max_concurrent_streams was missing entirely (I4 —
 * a user edit was silently shadowed by the persisted dynamic file for up to
 * 30 days), and nothing prevented the NEXT user-intent key from being
 * forgotten the same way (I5).
 *
 * Fix shape: the whitelist is now a single exported list,
 * DYNAMIC_CONFIG_RESYNC_KEYS (src/dynamic-config.ts), used by BOTH sites.
 * This test is data-driven over that list: for EVERY key it drives the real
 * extension with a stale dynamic config + a static override and asserts the
 * regenerated router-config.dynamic.json carries the STATIC value — the
 * uniform end-to-end observable for both resync sites.
 *
 * The list itself is pinned (the loop fails on an unexpected key and the
 * explicit expected-keys assertion fails on a removed one), so a future key
 * addition shows up here as a new failing case to give values for.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DYNAMIC_CONFIG_RESYNC_KEYS } from '../src/dynamic-config.ts';
import { flushBackgroundScan } from './helpers/noop-scan-cache.ts';

const stateDir = process.env.PI_ROUTER_STATE_DIR!;
const dynamicConfigPath = path.join(stateDir, 'router-config.dynamic.json');
const scanCachePath = path.join(stateDir, '.cache', 'scan-cache.json');

// The full whitelist — pinned so a key added to the list (new failing test
// case) or silently removed from it fails HERE first, loudly.
const EXPECTED_KEYS = [
  'exclude',
  'non_agent_model_prefixes',
  'empty_response_timeout_ms',
  'reasoning_empty_response_timeout_ms',
  'stall_timeout_ms',
  'rate_limit_wait_max_ms',
  'backoff_minutes',
  'soft_backoff_ms',
  'delegation',
  'ollama_max_concurrent_streams',
] as const;

describe('DYNAMIC_CONFIG_RESYNC_KEYS whitelist', () => {
  it('contains exactly the known user-intent keys (pin — loud failure on add/remove)', () => {
    expect([...DYNAMIC_CONFIG_RESYNC_KEYS].sort()).toEqual([...EXPECTED_KEYS].sort());
  });
});

/** Stale value persisted in the dynamic file (what the user changed AWAY from). */
const STALE_VALUES: Record<string, unknown> = {
  exclude: { models: ['stale-provider/stale-model'] },
  non_agent_model_prefixes: ['stale-prefix/'],
  empty_response_timeout_ms: 999_001,
  reasoning_empty_response_timeout_ms: 999_002,
  stall_timeout_ms: 999_003,
  rate_limit_wait_max_ms: 999_004,
  backoff_minutes: [999],
  soft_backoff_ms: 999_005,
  delegation: { enabled: false, min_length: 999_999 },
  ollama_max_concurrent_streams: 42,
};

/** Fresh value in the PROJECT config layer (what the user changed TO). */
const FRESH_VALUES: Record<string, unknown> = {
  exclude: { models: ['fresh-provider/fresh-model'] },
  non_agent_model_prefixes: ['fresh-prefix/'],
  empty_response_timeout_ms: 111_001,
  reasoning_empty_response_timeout_ms: 111_002,
  stall_timeout_ms: 111_003,
  rate_limit_wait_max_ms: 111_004,
  backoff_minutes: [7],
  soft_backoff_ms: 111_005,
  delegation: { enabled: true, min_length: 123 },
  ollama_max_concurrent_streams: 2,
};

function assertResynced(key: string, written: Record<string, any>): void {
  const fresh = FRESH_VALUES[key];
  const stale = STALE_VALUES[key];
  if (key === 'exclude') {
    // exclude arrays are UNIONED across static layers — the fresh entry must
    // be present, the stale (dynamic-file-only) one must be gone.
    expect(written.exclude.models).toContain('fresh-provider/fresh-model');
    expect(written.exclude.models).not.toContain('stale-provider/stale-model');
  } else if (key === 'delegation') {
    expect(written.delegation.enabled).toBe(true);
    expect(written.delegation.min_length).toBe(123);
  } else if (Array.isArray(fresh)) {
    expect(written[key]).toEqual(fresh);
  } else {
    expect(written[key]).toBe(fresh);
  }
  void stale;
}

for (const key of DYNAMIC_CONFIG_RESYNC_KEYS) {
  describe(`dynamic-config staleness: ${key}`, () => {
    it('regenerates the dynamic config with the STATIC value, not the stale dynamic one', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-resync-'));
      fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
      // Project config: fresh value for THIS key.
      fs.writeFileSync(
        path.join(tmpDir, '.pi', 'router-config.json'),
        JSON.stringify({ [key]: FRESH_VALUES[key] })
      );
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const bakSuffix = '.resync-bak';
      const hadDyn = fs.existsSync(dynamicConfigPath);
      const hadCache = fs.existsSync(scanCachePath);
      if (hadDyn) fs.renameSync(dynamicConfigPath, `${dynamicConfigPath}${bakSuffix}`);
      if (hadCache) fs.renameSync(scanCachePath, `${scanCachePath}${bakSuffix}`);

      // Stale dynamic config on disk — every OTHER whitelist key fresh-ish so
      // only this iteration's key differs, plus the model_groups marker that
      // makes load() accept it as a valid dynamic config.
      const staleDynamic: Record<string, unknown> = {
        _dynamic: { generated_at: new Date(0).toISOString(), source: 'router scan', model_count: 1 },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      };
      for (const k of DYNAMIC_CONFIG_RESYNC_KEYS) staleDynamic[k] = STALE_VALUES[k];
      fs.writeFileSync(dynamicConfigPath, JSON.stringify(staleDynamic, null, 2));

      // Scan cache: valid (so the unawaited session_start scan can't surprise
      // us), one scored model so the forced regeneration has something to
      // write, cached LLM match so populateLlmMatches early-returns.
      fs.mkdirSync(path.dirname(scanCachePath), { recursive: true });
      fs.writeFileSync(
        scanCachePath,
        JSON.stringify({
          lastScanTimestamp: Date.now(),
          gdpval_scraped: true,
          models_cached: new Date().toISOString(),
          dynamic_config_expected: true,
          available_models: [{ id: 'paid-model', provider: 'paid-cloud-provider', cost_per_m: 0 }],
          gdpval_scores: { 'paid-model-scored': 1000 },
          model_score_cache: { 'paid-cloud-provider/paid-model': 'paid-model-scored' },
          openrouter_pricing: {},
        })
      );

      // Network stays off for the whole test (gdpval scrape + any probe).
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() =>
        Promise.reject(new Error('network disabled during test'))) as typeof fetch;

      try {
        vi.resetModules();
        const mod = await import('../index.ts');
        const defaultExport = mod.default as any;

        const onHandlers: Record<string, Array<(ev: any, ctx: any) => any>> = {};
        const commands: Record<string, any> = {};
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn((name: string, def: any) => {
            commands[name] = def;
          }),
          registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => {
            (onHandlers[event] ??= []).push(handler);
          }),
        };
        defaultExport(pi);

        const paidModel = {
          provider: 'paid-cloud-provider',
          id: 'paid-model',
          api: 'openai-completions',
          contextWindow: 1_000_000,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const modelRegistry = {
          getAvailable: () => [paidModel],
          find: (_p: string, modelId: string) => (modelId === 'paid-model' ? paidModel : null),
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple: vi.fn() },
        };
        const ctx: any = {
          modelRegistry,
          cwd: tmpDir,
          ui: { setFooter: vi.fn(), notify: vi.fn() },
        };

        // Fire session_start first: the metrics module's registry handle
        // (setModelRegistry) is only wired there — without it the
        // streamability filter in generateDynamicConfigNow drops every
        // registry model as "unstreamable" and the regeneration no-ops
        // ("No models with GDPval scores"). The scan cache is valid, so the
        // unawaited background scan() early-returns; flushBackgroundScan()
        // lets it release the serialized() lock before /router scan runs.
        for (const h of onHandlers['session_start'] ?? []) await h({}, ctx);
        await flushBackgroundScan();

        // Force a regeneration via /router scan — the uniform observable is
        // the file the router writes back.
        await commands['router'].handler('scan', ctx);

        const written = JSON.parse(fs.readFileSync(dynamicConfigPath, 'utf-8'));
        assertResynced(key, written);
      } finally {
        globalThis.fetch = originalFetch;
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(dynamicConfigPath, { force: true });
        fs.rmSync(scanCachePath, { force: true });
        if (hadDyn) fs.renameSync(`${dynamicConfigPath}${bakSuffix}`, dynamicConfigPath);
        if (hadCache) fs.renameSync(`${scanCachePath}${bakSuffix}`, scanCachePath);
      }
    });
  });
}
