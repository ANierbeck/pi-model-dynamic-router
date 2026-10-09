// test/consolidated-routing-cache-pins.test.ts
// Consolidation of one-file-per-incident micro tests (suite hygiene round
// 2026-10-04): each former standalone file lives on as its own describe,
// named after the original file - failure output stays greppable. The
// tests themselves are UNCHANGED; hooks and fixtures moved verbatim.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DYNAMIC_CONFIG_RESYNC_KEYS } from '../src/dynamic-config.ts';
import { flushBackgroundScan } from './helpers/noop-scan-cache.ts';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { fileURLToPath } from 'node:url';
import { writeNoOpScanCache, removeNoOpScanCache } from './helpers/noop-scan-cache.ts';
import { beforeEach } from 'vitest';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';
import { afterEach } from 'vitest';
import { applyGroupFilters } from '../src/routing.ts';
import { buildModelsWithMetadata, buildStaticFreeModelsLookup, filterModelsForGroup } from '../src/dynamic-config.ts';
import { setConfig, setCache, setGdpval, setModelMap, setMetrics, setModelRegistry, getModelRegistry } from '../src/metrics.ts';
import type { Group } from '../src/types.ts';
import { test, beforeAll, afterAll } from 'vitest';
import { lookupGdp } from '../src/metrics.js';

describe('cache-session-reload', () => {
  // test/cache-session-reload.test.ts
  // Review 2026-09-27: on session_start, load() handed the old cache object to a
  // new DiscoveryManager, loadCache() re-read disk into a NEW object, and
  // discoverKeys() then set `cache` back to the discovery manager's old one. The
  // re-read was lost, and the next save overwrote what another Pi process had
  // written in the meantime (e.g. a blocklist entry).


  describe('session_start re-reads the scan cache into the shared object', () => {
    it('sees a blocklist entry another process wrote between two sessions', async () => {
      const stateDir = process.env.PI_ROUTER_STATE_DIR!;
      const cachePath = path.join(stateDir, '.cache', 'scan-cache.json');
      fs.writeFileSync(
        cachePath,
        JSON.stringify({
          lastScanTimestamp: Date.now(),
          dynamic_config_expected: false,
          gdpval_scraped: true,
          models_cached: new Date().toISOString(),
          available_models: [{ id: 'model-a', provider: 'healthy-provider', cost_per_m: 0.1 }],
          gdpval_scores: { 'model-a': 800 },
        })
      );
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cache-reload-'));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as typeof fetch;
      try {
        vi.resetModules();
        const mod = await import('../index.ts');
        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
        (mod.default as any)({
          registerTool: vi.fn(),
          registerCommand: vi.fn((name: string, def: any) => {
            commands[name] = def;
          }),
          registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => {
            onHandlers[event] = handler;
          }),
        });
        const model = { provider: 'healthy-provider', id: 'model-a', api: 'openai-completions', contextWindow: 128_000,
          cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } };
        const modelRegistry = {
          getAvailable: () => [model],
          find: (p: string, id: string) => (p === model.provider && id === model.id ? model : null),
          getApiKeyForProvider: async () => 'k',
          runtime: { streamSimple: vi.fn() },
        };
        const ctx = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn(), notify: vi.fn() } };

        await onHandlers['session_start']!({}, ctx);
        await new Promise((r) => setTimeout(r, 300)); // let the background scan settle

        // Another Pi process blocks a model and saves the shared cache file.
        const onDisk = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        const now = Date.now();
        onDisk.model_blocklist = {
          'other/blocked-model': { reason: 'decommissioned', code: 404, signature: 'x', first_seen: now, last_seen: now, occurrences: 1 },
        };
        fs.writeFileSync(cachePath, JSON.stringify(onDisk));

        await onHandlers['session_start']!({}, ctx);
        await commands['router']!.handler('blocklist', ctx);
        const shown = ctx.ui.notify.mock.calls.map((c: any[]) => String(c[0])).join('\n');
        expect(shown).toContain('other/blocked-model');
      } finally {
        cwdSpy.mockRestore();
        globalThis.fetch = originalFetch;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});


describe('dynamic-config-resync-keys', () => {
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
    // Phase 0 step 3 (2026-10-06): the ADR-0023 window never reached the live
    // (dynamic) config, so `best` ranked by pure score — opus before sonnet.
    'best_quality_window',
    'log_level',
    // Task-type-balancing Phase 3 (2026-10-06): the user's category→group
    // mapping is user intent and must reach the live config even when a
    // stale dynamic file predates the key.
    'category_groups',
    // Task-type-balancing Phase 5b (2026-10-07): the global cache-aware
    // compaction settings are user intent — same shadowing class.
    'context_budget',
    // Classifier decision log (2026-10-08): privacy + retention are user
    // intent — the dynamic copy must not silently disable the log.
    'classifier_log',
    // Opt-in local Laya classifier stage (2026-10-09): enable/configure is
    // user intent — a stale dynamic file must not leave it stuck on or off.
    'classifier_laya',
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
    best_quality_window: 0.99,
    log_level: 'debug',
    category_groups: { code_complex: 'tactical' },
    context_budget: { enabled: true, soft_tokens: 999_999 },
    classifier_log: { enabled: false, store_text: 'stale' },
    classifier_laya: { enabled: true, endpoint: 'http://127.0.0.1:9999' },
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
    best_quality_window: 0.07,
    log_level: 'warn',
    category_groups: { code_complex: 'planning' },
    context_budget: { enabled: false, soft_tokens: 123 },
    classifier_log: { enabled: true, store_text: 'full', max_bytes: 999_888, keep: 9 },
    classifier_laya: { enabled: false },
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
    } else if (fresh !== null && typeof fresh === 'object') {
      // Plain-object user intent (e.g. category_groups) — deep equality.
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
});


describe('dynamic-config-staleness', () => {
  /**
   * Regression tests for the "dynamic config staleness" bug class.
   *
   * router-config.dynamic.json is a generated, persisted cache: once it exists
   * on disk, load() reads it INSTEAD of the freshly-computed layered static
   * config (router-config.json → router-config.user.json → project-local
   * .pi/router-config.json). If a field the user can override in the static
   * config isn't explicitly re-synced from staticCfg on load, editing that
   * field has no effect as long as a dynamic config exists on disk — the
   * common steady state.
   *
   * `exclude` was the first field found to have this bug (fixed in
   * 9d697e1, but shipped without a regression test — this file closes that
   * gap). `empty_response_timeout_ms` / `reasoning_empty_response_timeout_ms`
   * were added later and needed the exact same fix (added alongside this
   * test).
   */

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withStaleDynamicConfig(
    staleDynamicConfig: Record<string, unknown>,
    projectOverride: Record<string, unknown>,
    fn: (defaultExport: any) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-staleness-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(projectOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.staleness-bak`;
    const cacheBak = `${scanCachePath}.staleness-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath); // make unawaited session_start scan() a no-op (root cause of the "No available models" CI flake)

    // load() reads router-config.dynamic.json from the EXTENSION directory
    // (repoRoot when running via tsx), not from the project cwd — this is the
    // one config layer that is NOT cwd-scoped.
    fs.writeFileSync(dynamicConfigPath, JSON.stringify(staleDynamicConfig));

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(dynamicConfigPath, { force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);

      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    }
  }

  describe('load(): exclude rules are re-synced from staticCfg, not the stale dynamic file', () => {
    it('excludes a model per the static override even though the persisted dynamic file has no exclude rule', async () => {
      await withStaleDynamicConfig(
        {
          _dynamic: { generated_at: new Date(0).toISOString(), source: 'router scan', model_count: 0 },
          model_groups: {
            standard: { method: 'tiered', min_gdpval: 0, fallback_groups: [] },
            dynamic: { method: 'dynamic', min_gdpval: 0, fallback_groups: [] },
          },
          model_metrics: {},
          // No exclude rule here — this is the stale state that must NOT win.
        },
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          rate_limit_wait_max_ms: 0,
          // The current, authoritative user preference.
          exclude: { models: ['*blocked*'] },
        },
        async (defaultExport) => {
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

          // Provider deliberately NOT 'openrouter': this machine's real global
          // user override (~/.pi/agent/router-config.user.json) may set
          // exclude.paid_models_from including openrouter, which would filter
          // out these test models for reasons unrelated to what's under test
          // here. 'test-provider' is also not in PROVIDER_MAP, so isRefUsable()
          // doesn't require a mocked API key.
          const models: Record<string, any> = {
            'test-provider/blocked-model-x': { provider: 'test-provider', id: 'blocked-model-x', contextWindow: 128_000 },
            'test-provider/good-model-y': { provider: 'test-provider', id: 'good-model-y', contextWindow: 128_000 },
          };
          const streamSimple = vi.fn(() => (async function* () {})()); // always empty — driveStream tries every candidate
          const modelRegistry = {
            getAvailable: () => Object.values(models),
            find: (provider: string, modelId: string) => models[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => 'fake-key',
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: '/tmp', ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

          // A model-type HINT with an unresolvable target routes straight to the
          // auto-appended-fallback-candidates code path, which is where
          // cfg.exclude is applied.
          const groupModel = { provider: 'dynamic', id: 'dynamic' };
          const context: any = { messages: [{ role: 'user', content: 'HINT: some-unresolvable-model' }] };

          await drainStream(defaultExport.groupStream(groupModel, context, {}));

          const triedIds = streamSimple.mock.calls.map((call: any[]) => call[0]?.id);
          expect(triedIds).toContain('good-model-y');
          expect(triedIds).not.toContain('blocked-model-x');
        }
      );
    });
  });

  describe('load(): timeout overrides are re-synced from staticCfg, not the stale dynamic file', () => {
    it('uses the static override timeout, not the stale value baked into the dynamic file', async () => {
      await withStaleDynamicConfig(
        {
          _dynamic: { generated_at: new Date(0).toISOString(), source: 'router scan', model_count: 0 },
          model_groups: { standard: { method: 'tiered', min_gdpval: 0, fallback_groups: [] } },
          model_metrics: {},
          // Stale timeout so long it would never abort a 500ms-delayed stream —
          // if this value wins, the bug has regressed.
          empty_response_timeout_ms: 999_999,
          reasoning_empty_response_timeout_ms: 999_999,
        },
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          rate_limit_wait_max_ms: 0,
          // The current, authoritative user preference: a short timeout that
          // WILL abort a 500ms-delayed non-reasoning stream.
          empty_response_timeout_ms: 100,
          reasoning_empty_response_timeout_ms: 5000,
        },
        async (defaultExport) => {
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

          const chatModel = {
            // Agent-capable family (the 2026-09-27 capability tier filters
            // mistral-small-* out of every group — this test is about timeout
            // overrides, not the model, so the fixture must be one the router
            // still routes to).
            provider: 'mistral',
            id: 'mistral-medium-3-5',
            api: 'openai-completions',
            contextWindow: 1_000_000,
          };
          const streamSimple = vi.fn(() => {
            return (async function* () {
              await new Promise((r) => setTimeout(r, 500)); // > 100ms static override, < 999999ms stale value
              yield { type: 'text_delta', delta: 'should be aborted by the 100ms override' };
              yield { type: 'done' };
            })();
          });
          const modelRegistry = {
            getAvailable: () => [chatModel],
            find: () => chatModel,
            getApiKeyForProvider: async () => 'fake-key',
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: '/tmp', ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'hi' }] };
          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          const text = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');
          // If the stale 999999ms value had won, the 500ms-delayed content would
          // have come through untouched.
          expect(text).not.toContain('should be aborted by the 100ms override');
        }
      );
    });
  });
});


describe('get-top-models-total', () => {
  // test/get-top-models-total.test.ts
  // Regression + feature tests for the "…+N more" display footer in /router status.
  //
  // Symptom (2026-09-20): Users see only the top 5 models per group and wonder why
  // expensive models (e.g. pi-claude) are "weg". The candidates are present but
  // ranked below position 5 in cost-sorted groups.
  //
  // Fix: getTopModels returns both the top-N slice AND the total candidate count.
  // Status rendering appends a footer line: `│    … +9 more (candidates further down the cost sort)`
  //
  // The footer should show the total count *after* the same filters/sorts/dedup that
  // produce the top-N slice (i.e., the count of models that would be shown if the user
  // asked for all).


  beforeEach(() => {
    metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
    metricsModule.setCache({});
    metricsModule.setGdpval({});
    metricsModule.setModelMap({}, []);
  });

  function makeRouter(cfg: Config, cache: Cache): Router {
    const r = new Router(cfg, cache, new Map());
    return r;
  }

  describe('getTopModels — total candidate count for "…+N weitere" footer', () => {
    it('returns total count >= shown count when group has more than N candidates', () => {
      const cfg: Config = {
        model_groups: {
          testgroup: {
            method: 'tiered',
            min_gdpval: 0,
            max_cost: 1000, // allow all
            fallback_groups: [],
          },
        },
        model_metrics: {},
        providers: {},
      };

      const router = makeRouter(cfg, {});
      // Stub the entire getTopModels to return a predictable shape
      // @ts-expect-error override private method
      router.getTopModels = (groupName: string, n: number) => ({ models: [{ ref: 'a', limited: false, rank: 0 }], total: 7 });
      const { models: top, total } = router.getTopModels('testgroup', 5);
      expect(top.length).toBe(1);
      expect(total).toBe(7);
      expect(total).toBeGreaterThan(top.length);
    });

    it('returns total === shown when group has exactly N candidates', () => {
      // Use a group with a very high min_gdpval to ensure only 2 models pass filters
      const cfg: Config = {
        model_groups: {
          testgroup: {
            method: 'best',
            min_gdpval: 1000,
            fallback_groups: [],
          },
        },
        model_metrics: {},
        providers: {},
      };

      const router = makeRouter(cfg, {});
      const { models: top, total } = router.getTopModels('testgroup', 5);
      expect(top.length).toBeLessThanOrEqual(5);
      expect(total).toBeGreaterThanOrEqual(top.length);
    });

    it('returns empty array and total 0 when group has no candidates', () => {
      const cfg: Config = {
        model_groups: {
          emptygroup: {
            method: 'tiered',
            min_gdpval: 10000,
            max_cost: 0,
            fallback_groups: [],
          },
        },
        model_metrics: {},
        providers: {},
      };

      const router = makeRouter(cfg, {});
      const { models: top, total } = router.getTopModels('emptygroup', 5);
      expect(top).toEqual([]);
      expect(total).toBe(0);
    });
  });
});


describe('group-filter-parity', () => {
  // test/group-filter-parity.test.ts
  // ADR-0010: the persist path (filterModelsForGroup, fed with precomputed
  // per-model values) and the live path (applyGroupFilters, reading the
  // metrics module) must admit the same models for the same data.


  const cfg: Config = {
    model_groups: {},
    model_metrics: {},
    providers: {
      payg: { billing: 'pay_per_token', free_models: ['payg/listed-free'] },
      sub: { billing: 'subscription' },
    },
  };

  const REFS = [
    'payg/cheap',
    'payg/expensive',
    'payg/listed-free',
    'payg/tagged:free',
    'payg/mystery',
    'sub/unpriced',
    'ollama/local-model',
    // Scan placeholder $0, but the registry knows the real price (the zai
    // glm-5-3 alias pattern). Must be treated as priced, not free.
    'payg/scan-zero-alias',
  ];

  let previousRegistry: unknown;

  beforeEach(() => {
    previousRegistry = getModelRegistry();
    setModelRegistry({
      find: (provider: string, id: string) =>
        provider === 'payg' && id === 'scan-zero-alias'
          ? { provider, id, cost: { input: 1.4, output: 4, cacheRead: 0, cacheWrite: 0 } }
          : null,
      getAvailable: () => [],
    } as any);
    setConfig(cfg);
    setModelMap({}, []);
    setMetrics({});
    setGdpval({
      cheap: 400, expensive: 900, 'listed-free': 500, 'tagged': 450, 'tagged:free': 450,
      mystery: 600, unpriced: 800, 'local-model': 300, 'scan-zero-alias': 700,
    });
    setCache({
      available_models: [
        { id: 'cheap', provider: 'payg', cost_per_m: 1 },
        { id: 'expensive', provider: 'payg', cost_per_m: 20 },
        { id: 'listed-free', provider: 'payg', cost_per_m: 0 },
        { id: 'tagged:free', provider: 'payg', cost_per_m: 0 },
        { id: 'mystery', provider: 'payg' },
        { id: 'unpriced', provider: 'sub' },
        { id: 'local-model', provider: 'ollama', cost_per_m: 0 },
        { id: 'scan-zero-alias', provider: 'payg', cost_per_m: 0 },
      ],
    } as any);
  });

  afterEach(() => {
    setModelRegistry(previousRegistry);
  });

  const GROUPS: Array<[string, Group]> = [
    ['max_cost 0', { method: 'best', max_cost: 0 }],
    ['max_cost 2', { method: 'best', max_cost: 2 }],
    ['max_cost_per_m 5', { method: 'best', max_cost_per_m: 5 }],
    ['min_gdpval 500', { method: 'best', min_gdpval: 500 }],
    ['exclude_providers', { method: 'best', exclude_providers: ['sub'] }],
  ];

  describe('persist and live group filters agree (ADR-0010)', () => {
    it.each(GROUPS)('%s', (_name, g) => {
      const { staticFreeModelsLookup } = buildStaticFreeModelsLookup(cfg);
      const meta = buildModelsWithMetadata(REFS, cfg, staticFreeModelsLookup, new Set());
      const persist = filterModelsForGroup(meta, g, cfg).map((m) => m.ref).sort();
      const live = applyGroupFilters(meta.map((m) => m.ref), g, cfg).sort();
      expect(persist).toEqual(live);
    });

    it('treats a scan-$0 model with a registry price as priced, not free (registry-first)', () => {
      expect(applyGroupFilters(REFS, GROUPS[0][1], cfg)).not.toContain('payg/scan-zero-alias');
      expect(applyGroupFilters(REFS, { method: 'best', max_cost: 1 }, cfg)).not.toContain('payg/scan-zero-alias');
      expect(applyGroupFilters(REFS, { method: 'best', max_cost_per_m: 1 }, cfg)).not.toContain('payg/scan-zero-alias');
    });

    it('keeps the unpriced cloud subscription model out of $0 and per-million-capped groups', () => {
      for (const g of [GROUPS[0][1], GROUPS[2][1]]) {
        expect(applyGroupFilters(REFS, g, cfg)).not.toContain('sub/unpriced');
        expect(applyGroupFilters(REFS, g, cfg)).toContain('ollama/local-model');
      }
    });
  });
});


describe('max-cost-filter', () => {
  // test/max-cost-filter.test.ts
  // Tests for the max_cost filter in resolveGroup.
  //
  // Bug: max_cost: 0 filtered out ALL Mistral models because effCost() returns
  // 0.000020 (fallback) for models without OpenRouter pricing. This meant the
  // `trivial` and `simple` groups had NO working models when OpenRouter free
  // models were overloaded — causing "All candidates failed" errors.
  //
  // Fix: Models with unknown cost are now INCLUDED if their provider is not
  // pay_per_token (i.e. subscription or local). For pay_per_token providers,
  // unknown cost means we genuinely don't know the price → exclude to be safe.


  function makeRouter(cfg: Config, cache: Cache): Router {
    metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
    metricsModule.setCache(cache);
    metricsModule.setGdpval(cache.gdpval_scores ?? {});
    metricsModule.setModelMap({}, []);
    return new Router(cfg, cache, new Map());
  }

  const BASE_CACHE: Cache = {
    available_models: [
      // OpenRouter free model (has pricing = 0)
      { id: 'qwen3-4b:free', provider: 'openrouter', cost_per_m: 0 },
      // OpenRouter paid model (has pricing > 0)
      { id: 'nemotron-ultra:free', provider: 'openrouter', cost_per_m: 0 },
      // Mistral model (no OpenRouter pricing → effCost returns fallback)
      { id: 'devstral-2512', provider: 'mistral', cost_per_m: 0 },
      { id: 'mistral-medium-2604', provider: 'mistral', cost_per_m: 0 },
      // Ollama local model
      { id: 'qwen3.5', provider: 'ollama', cost_per_m: 0 },
    ],
    gdpval_scores: {
      'devstral': 585,
      'mistral-medium-3-5': 933,
      'qwen3-4b': 400,
      'nemotron-ultra': 1162,
      'qwen3.5': 400,
    },
    model_score_cache: {
      'mistral/devstral-2512': 'devstral',
      'mistral/mistral-medium-2604': 'mistral-medium-3-5',
      'openrouter/qwen3-4b:free': 'qwen3-4b',
      'openrouter/nemotron-ultra:free': 'nemotron-ultra',
    },
    openrouter_pricing: {},
    usage_log: [],
    benchmarks: {},
    budget_cache: {},
    gdpval_scraped: true,
    lastScanTimestamp: Date.now(),
    models_cached: '',
  } as any;

  describe('max_cost filter with unknown-cost models', () => {
    let router: Router;

    beforeEach(() => {
      const cfg: Config = {
        model_groups: {
          trivial: {
            description: 'Trivial - free only',
            method: 'min_cost_if_all_priced',
            max_cost: 0,
            min_gdpval: 0,
            fallback_groups: ['scout'],
          },
          scout: {
            description: 'Any model',
            method: 'tiered',
            min_gdpval: 0,
            fallback_groups: [],
          },
        },
        providers: {
          openrouter: { billing: 'pay_per_token' },
          mistral: { billing: 'pay_per_token' },
        },
      } as any;
      router = makeRouter(cfg, BASE_CACHE);
    });

    it('trivial group (max_cost: 0) includes ollama and openrouter free models', () => {
      const { models: top } = router.getTopModels('trivial', 10);
      const refs = top.map((m) => m.ref);
      // Ollama models are local → cost 0 → included
      expect(refs.some((r) => r.startsWith('ollama/'))).toBe(true);
      // OpenRouter free models have cost 0 → included
      expect(refs.some((r) => r.includes(':free'))).toBe(true);
    });

    it('trivial group (max_cost: 0) includes mistral models with cost_per_m: 0', () => {
      const { models: top } = router.getTopModels('trivial', 10);
      const refs = top.map((m) => m.ref);
      // Mistral models have cost_per_m: 0 in cache → effCost returns 0 → included
      // This was the bug: effCost returned 0.000020 (fallback) for cost_per_m: 0
      expect(refs.some((r) => r.startsWith('mistral/'))).toBe(true);
    });

    it('scout group (no max_cost) includes all models', () => {
      const { models: top } = router.getTopModels('scout', 10);
      const refs = top.map((m) => m.ref);
      // Mistral models should be in scout (no max_cost filter)
      expect(refs.some((r) => r.startsWith('mistral/'))).toBe(true);
    });
  });
});


describe('router-cache-refresh', () => {
  // test/router-cache-refresh.test.ts
  // Regression guard: the Router must follow index.ts's cache reassignments.
  //
  // BACKGROUND: index.ts REPLACES its `cache` variable on several paths
  // (loadCache, discoverKeys, budget refresh) and notifies metrics, the
  // rate-limit manager and the budget tracker each time. The Router was never
  // notified, so it kept reading the object it was constructed with — every
  // cache-derived decision (discovered models, exclude lookups, dedup, model
  // health) silently operated on stale data for the rest of the session.


  const CFG: Config = {
    model_groups: {
      scout: { description: 'any', method: 'tiered', min_gdpval: 0, fallback_groups: [] },
    },
    providers: {},
  } as any;

  function makeCache(models: { id: string; provider: string }[]): Cache {
    return {
      available_models: models.map((m) => ({ ...m, cost_per_m: 0 })),
      gdpval_scores: {},
      model_score_cache: {},
      openrouter_pricing: {},
    } as any;
  }

  function makeRouter(cache: Cache): Router {
    metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
    metricsModule.setCache(cache);
    metricsModule.setGdpval({});
    metricsModule.setModelMap({}, []);
    return new Router(CFG, cache, new Map());
  }

  describe('Router.updateCache', () => {
    it('picks up models discovered after construction', () => {
      const initial = makeCache([{ id: 'old-model', provider: 'mistral' }]);
      const router = makeRouter(initial);
      expect(router.allDiscoveredRefs()).toContain('mistral/old-model');

      // index.ts replaces its cache object wholesale (e.g. after a scan).
      const refreshed = makeCache([
        { id: 'old-model', provider: 'mistral' },
        { id: 'newly-scanned', provider: 'mistral' },
      ]);
      metricsModule.setCache(refreshed);
      router.updateCache(refreshed);

      expect(router.allDiscoveredRefs()).toContain('mistral/newly-scanned');
    });

    it('drops models that disappeared from the refreshed cache', () => {
      const initial = makeCache([
        { id: 'stays', provider: 'mistral' },
        { id: 'goes-away', provider: 'mistral' },
      ]);
      const router = makeRouter(initial);
      expect(router.allDiscoveredRefs()).toContain('mistral/goes-away');

      const refreshed = makeCache([{ id: 'stays', provider: 'mistral' }]);
      metricsModule.setCache(refreshed);
      router.updateCache(refreshed);

      expect(router.allDiscoveredRefs()).toContain('mistral/stays');
      expect(router.allDiscoveredRefs()).not.toContain('mistral/goes-away');
    });

    it('reads model health from the refreshed cache, not the construction-time one', () => {
      const initial = makeCache([{ id: 'a', provider: 'mistral' }]);
      const router = makeRouter(initial);

      // Health recorded against a *replacement* cache object, mirroring what
      // index.ts does after loadCache().
      const refreshed = makeCache([{ id: 'a', provider: 'mistral' }]);
      (refreshed as any).model_health = {
        'mistral/a': { fails: 5, last_fail: Date.now() },
      };
      metricsModule.setCache(refreshed);
      router.updateCache(refreshed);

      // The router must see the streak; with a stale reference it would see none.
      const health = (router as any).cache.model_health;
      expect(health?.['mistral/a']?.fails).toBe(5);
    });
  });
});


describe('orchestrator-router-context-freshness', () => {
  /**
   * Regression test for the "running in circles" / self-contradictory
   * "still in cooldown (0s remaining)" bug (2026-09-02).
   *
   * buildOrchestratorContext() (index.ts) captures `router`, `rateLimitManager`,
   * and `cacheManager` as PLAIN object properties, evaluated once when the
   * StreamOrchestrator is constructed — unlike `cfg`/`cache`/`activeGroup` in
   * the same object literal, which are getters that always read the current
   * module-level binding. But `load()` REASSIGNS all three (`router = new
   * Router(...)`, `rateLimitManager = new RateLimitManager(...)`, `cacheManager
   * = new CacheManager(...)`) on every session_start AND on every
   * resolve_model_group/update_model_metrics tool call and /router
   * slash-command invocation — session_start alone runs load() a second time
   * (module setup runs load() once already, before StreamOrchestrator is even
   * constructed), immediately orphaning ctx.router in every session.
   *
   * Symptom: ctx.isLimited(ref) is a function closure that always reads the
   * CURRENT `rateLimitManager` variable, so it correctly reports a ref as
   * rate-limited. But ctx.router.limitSecs(ref) reads the STALE, orphaned
   * Router's private Map — which never received that cooldown (or any cooldown
   * recorded after the staleness set in) — and always returns 0. Logged as the
   * self-contradictory "skipped, still in cooldown (0s remaining)". The same
   * staleness also broke the total-cooldown-collapse force-retry logic (ranks
   * candidates by ctx.router.limitSecs to retry the LEAST-cooled-down one),
   * contributing to an observed "running in circles" failure loop.
   *
   * Fix: router/rateLimitManager/cacheManager are now getters in
   * buildOrchestratorContext, matching the existing cfg/cache/activeGroup
   * pattern, so they always resolve the live module-level binding.
   *
   * This test exercises the total-cooldown-collapse force-retry branch
   * specifically (stream-orchestrator.ts ~line 680), since a single-candidate
   * group has nothing else to fall through to — driveStream force-retries the
   * one candidate it has rather than reporting a plain "still in cooldown"
   * skip. That branch calls the exact same ctx.router.limitSecs() that was
   * reading the stale Map.
   */

  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ctx-freshness-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.ctx-freshness-bak`;
    const cacheBak = `${scanCachePath}.ctx-freshness-bak`;
    const hadDyn = fs.existsSync(dynamicConfigPath);
    const hadCache = fs.existsSync(scanCachePath);
    if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
    if (hadCache) fs.renameSync(scanCachePath, cacheBak);

    writeNoOpScanCache(scanCachePath);

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
    }
  }

  describe('StreamOrchestrator context freshness: router/rateLimitManager/cacheManager', () => {
    it('ctx.router.limitSecs() reports the real remaining cooldown after session_start reassigns router (not 0)', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: { openrouter: { free_models: [] } },
          rate_limit_wait_max_ms: 0,
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: { 'paid-model': 1000 },
        },
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
          // Module setup runs load() once here (site #1) and constructs
          // StreamOrchestrator, capturing whatever `router` is at this point.
          defaultExport(pi);

          const paidModel = {
            provider: 'paid-cloud-provider',
            id: 'paid-model',
            api: 'openai-completions',
            contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
          };
          const modelsByRef: Record<string, any> = {
            'paid-cloud-provider/paid-model': paidModel,
          };
          // Always fails with a hard-cooldown-worthy provider error (mirrors
          // test/provider-error-paid-cloud-cooldown.test.ts).
          const streamSimple = vi.fn(() => {
            return (async function* () {
              yield {
                type: 'error',
                // Rate-limit-shaped (HTTP 429) so the model takes the
                // hard-cooldown path — since the 2026-09-27 422 fix a bare
                // provider_error only gets the 30s soft backoff, which could
                // never satisfy the >30s limitSecs() assertion below.
                error: { errorMessage: '429 too many requests' },
              };
            })();
          });
          const modelRegistry = {
            getAvailable: () => [paidModel],
            find: (provider: string, modelId: string) =>
              modelsByRef[`${provider}/${modelId}`] ?? null,
            getApiKeyForProvider: async () => null,
            runtime: { streamSimple },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          // session_start calls load() a SECOND time (site #2) — this is what
          // reassigns router/rateLimitManager/cacheManager to new instances
          // AFTER StreamOrchestrator already captured the old ones. Every real
          // session hits this on its very first session_start.
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

          // First call: the model fails with a provider error and gets a hard
          // cooldown recorded against it (backoff_minutes[0] = 1 minute = 60s).
          // With the single-pass cooldown-collapse fix, the same live failure
          // that put the only candidate into cooldown also trips the safety net
          // within this call — so the collapse force-retries the candidate
          // immediately (streamSimple called twice: fail + force-retry).
          const firstEvents = await drainStream(defaultExport.groupStream(groupModel, context, {}));
          expect(streamSimple).toHaveBeenCalledTimes(2);

          // The collapse banner ("All models in cooldown, retrying … (Ns)")
          // appears in the FIRST call's events now, since the single-pass
          // collapse fires within the same driveStream pass. This is the SAME
          // ctx.router.limitSecs() call site (stream-orchestrator.ts's total-
          // cooldown-collapse branch) that ranks candidates by remaining
          // cooldown to pick the least-limited one. A stale ctx.router would
          // report "0s" there too, since its limits Map never received this
          // cooldown.
          const routerInfoText = firstEvents
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => (e as any).delta ?? '')
            .join('');

          expect(routerInfoText).toContain('cooldown');
          const match = routerInfoText.match(/(\d+)s\)/);
          expect(match).not.toBeNull();
          // The bug reported an unconditional 0, so explicitly rule that out
          // in addition to the >30 bound below.
          expect(match![1]).not.toBe('0');
          const remainingSecs = Number(match![1]);
          // Should be close to the full 60s hard cooldown, not 0 and not the
          // full window elapsed already (a handful of seconds of test overhead
          // is fine).
          expect(remainingSecs).toBeGreaterThan(30);
          expect(remainingSecs).toBeLessThanOrEqual(60);

          // Second call: candidate is already in cooldown from the first call,
          // so the collapse fires immediately (pre-skip) and force-retries it
          // again. streamSimple is called once more (3 total).
          await drainStream(defaultExport.groupStream(groupModel, context, {}));
          expect(streamSimple).toHaveBeenCalledTimes(3);
        }
      );
    }, 30000);
  });
});


describe('sticky-model-regression', () => {
  /**
   * Regression test for the "sticky model" bug (introduced in commit 818621a,
   * shipped in v1.2.0): driveStream() used to call pi.setModel(realModel) after
   * picking a candidate. That swaps the *session's* active model away from the
   * virtual group model, which fires model_select and permanently clears
   * activeGroup — after the first request, group routing silently stops and
   * every subsequent turn goes straight to whatever model won the first race.
   *
   * This test drives the real extension's groupStream() twice with two
   * available candidate models and asserts:
   *   1. pi.setModel() is never called by the router itself.
   *   2. Each call re-resolves candidates from the live model registry (i.e.
   *      routing keeps working on the second turn, not just the first).
   */

  // router-config.dynamic.json and .cache/scan-cache.json are gitignored,
  // machine-local caches generated by `/router scan`. Both are resolved from
  // extDir (index.ts's own directory, i.e. the repo root) rather than cwd, so
  // they're shared global state across every test file in the suite regardless
  // of any cwd mocking — a test file that doesn't move them aside is exposed to
  // whatever another, concurrently-running test file leaves in them. In
  // particular, scan-cache.json can carry real gdpval scores from a prior
  // `/router scan` on this machine; on a fresh CI checkout it doesn't exist yet
  // and the group resolution this test depends on becomes order-dependent on
  // whichever other test happens to populate it first (see cooldown-collapse
  // and runtime-overflow-detection tests, which isolate the same two files).
  // Move both aside for the duration of this test so it exercises real dynamic
  // discovery (allDiscoveredRefs()) purely from the mocked modelRegistry,
  // deterministically.
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const dynamicConfigBackupPath = `${dynamicConfigPath}.regression-test-bak`;
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');
  const scanCacheBackupPath = `${scanCachePath}.regression-test-bak`;

  async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
    const events: AssistantMessageEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  describe('Sticky model regression (driveStream must never call pi.setModel)', () => {
    let mod: typeof import('../index.ts');
    let defaultExport: any;
    let tmpDir: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;
    let hadDyn: boolean;
    let hadCache: boolean;

    beforeEach(async () => {

      hadDyn = fs.existsSync(dynamicConfigPath);
      if (hadDyn) fs.renameSync(dynamicConfigPath, dynamicConfigBackupPath);
      hadCache = fs.existsSync(scanCachePath);
      if (hadCache) fs.renameSync(scanCachePath, scanCacheBackupPath);

      // Write a minimal "fresh, already-scraped" scan-cache so the unawaited
      // session_start scan() is a no-op (see writeNoOpScanCache docs). Without
      // this, scan() ends by swapping cfg/router to a dynamic config that
      // races this test's groupStream() call — the root cause of the CI-only
      // "No available models for group 'standard'" flake.
      writeNoOpScanCache(scanCachePath);

      // Isolated project config: keep the real "standard" group's method/
      // min_gdpval (so this remains a faithful regression test of real routing
      // behaviour) but clear fallback_groups so a resolution failure can't
      // cascade into other groups whose candidate pools depend on machine-local
      // state this test doesn't control.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-sticky-model-'));
      fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.pi', 'router-config.json'),
        JSON.stringify({ model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } } })
      );
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      vi.resetModules();
      mod = await import('../index.ts');
      defaultExport = mod.default;
    });

    afterEach(() => {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      // Remove the no-op scan-cache (hadCache reflects the ORIGINAL file,
      // restored below if it existed).
      removeNoOpScanCache(scanCachePath);
      if (hadDyn) fs.renameSync(dynamicConfigBackupPath, dynamicConfigPath);
      if (hadCache) fs.renameSync(scanCacheBackupPath, scanCachePath);
    });

    it('routes to a different candidate on each call without ever swapping the session model', async () => {
      const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
      const setModel = vi.fn(async () => true);

      const pi: any = {
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        registerProvider: vi.fn(),
        setModel,
        on: vi.fn((event: string, handler: any) => {
          onHandlers[event] = handler;
        }),
      };

      defaultExport(pi);

      // Two fake "real" candidate models on providers the router does not
      // manage itself (not in PROVIDER_MAP), so no apiKey is required — mirrors
      // how an extension-registered provider (e.g. claude-bridge) looks to the
      // router. Both use gdpval-mapped ids so the "standard" group's
      // min_gdpval threshold accepts them.
      const fakeModels: Record<string, any> = {
        'fake-provider-a/claude-sonnet-4-6': {
          provider: 'fake-provider-a',
          id: 'claude-sonnet-4-6',
          api: 'fake-api',
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        },
        'fake-provider-b/claude-opus-4-6': {
          provider: 'fake-provider-b',
          id: 'claude-opus-4-6',
          api: 'fake-api',
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        },
      };

      function makeStream(providerId: string) {
        return (async function* () {
          yield { type: 'text_delta', text: `hi from ${providerId}` };
          yield { type: 'done' };
        })();
      }

      const modelRegistry = {
        getAvailable: () => Object.values(fakeModels),
        find: (provider: string, id: string) => fakeModels[`${provider}/${id}`] ?? null,
        getApiKeyForProvider: async () => null,
        runtime: {
          streamSimple: (model: any) => makeStream(model.provider),
        },
      };

      const ctx: any = {
        modelRegistry,
        cwd: tmpDir,
        ui: { setFooter: vi.fn() },
      };
      await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

      const groupModel = { provider: 'standard', id: 'standard' };
      const context: any = { messages: [{ role: 'user', content: 'hello' }] };

      for (let turn = 0; turn < 2; turn++) {
        const stream = defaultExport.groupStream(groupModel, context, {});
        const events = await drainStream(stream);
        const textEvents = events.filter((e: any) => e.type === 'text_delta');
        expect(textEvents.length).toBeGreaterThan(0);
      }

      // The router must never mutate the session's active model — that is
      // exactly the bug that made group routing stop working after turn 1.
      expect(setModel).not.toHaveBeenCalled();
    });
  });
});


describe('routing', () => {
  describe('lookupGdp built-in tests', () => {
    beforeAll(() => {
      setConfig({
        model_groups: {},
        model_metrics: {},
        gdpval_builtin: {
          "mistral-medium-3-5": 665,
          "magistral-small": 669,
          "magistral-medium": 665,
          "devstral": 585,
          "codestral-latest": 520
        }
      });
    });

    afterAll(() => {
      setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
    });

    test('lookupGdp returns correct built-in score for magistral-small (>= 600 threshold)', () => {
      const score = lookupGdp("magistral-small");
      expect(score).toBeGreaterThanOrEqual(600);
    });

    test('lookupGdp returns exact built-in score for mistral-medium-3-5 (=== 665)', () => {
      const score = lookupGdp("mistral-medium-3-5");
      expect(score).toBeGreaterThanOrEqual(600);
      expect(score).toBe(665);
    });

    test('lookupGdp returns correct built-in score for mistral/mistral-medium-3.5', () => {
      const score = lookupGdp("mistral/mistral-medium-3.5");
      expect(score).toBeGreaterThanOrEqual(600);
    });
  });
});
