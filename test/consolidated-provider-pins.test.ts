// test/consolidated-provider-pins.test.ts
// Consolidation of one-file-per-incident micro tests (suite hygiene round
// 2026-10-04): each former standalone file lives on as its own describe,
// named after the original file - failure output stays greppable. The
// tests themselves are UNCHANGED; hooks and fixtures moved verbatim.

import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNoOpScanCache, removeNoOpScanCache, flushBackgroundScan } from './helpers/noop-scan-cache.ts';

describe('free-model-on-demand-registration', () => {
  /**
   * Integration test: statically-configured free models (cfg.providers[provider]
   * .free_models) must be registered into Pi's model registry on demand when
   * tryStream encounters them, not silently skipped as "not registered".
   *
   * Reproduces the observed "claude-sonnet-5 dominates, GLM/free models unused"
   * symptom: free models listed in router-config.json never go through the
   * scan/cache.available_models path, so registerGroupModels never sees them,
   * and tryStream skipped every free model forever — the cascade fell through
   * to the next non-free model (claude-sonnet-5) on every turn.
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-free-reg-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.freereg-bak`;
    const cacheBak = `${scanCachePath}.freereg-bak`;
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

  describe('driveStream: on-demand free-model registration', () => {
    it('registers a configured free model into Pi registry when tryStream needs it, so it actually streams', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: {
            // A provider with a free model statically configured. The model is
            // NOT in cache.available_models (simulating the real situation:
            // statically-configured free models never go through the scan path).
            openrouter: {
              free_models: ['openrouter/test-vendor/fixture-model:free'],
              keys: [{ key: 'sk-or-test-fake-key' }],
            },
          },
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: { 'openrouter/test-vendor/fixture-model:free': 900 },
        },
        async (defaultExport, tmpDir) => {
          const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
          const registerProviderCalls: any[] = [];
          const pi: any = {
            registerTool: vi.fn(),
            registerCommand: vi.fn(),
            registerProvider: vi.fn((name: string, opts: any) => {
              registerProviderCalls.push({ name, opts });
              // Mirror how Pi's real registry makes the model findable after
              // registration: once openrouter is registered with the free
              // model id, find() should return it.
              if (name === 'openrouter' && Array.isArray(opts?.models)) {
                openrouterRegistered = true;
              }
            }),
            setModel: vi.fn(async () => true),
            on: vi.fn((event: string, handler: any) => {
              onHandlers[event] = handler;
            }),
          };
          defaultExport(pi);

          const freeModel = { provider: 'openrouter', id: 'test-vendor/fixture-model:free', api: 'openai-completions', contextWindow: 128_000 };
          // The model registry starts with the free model NOT findable (it's
          // not registered yet). After tryStream's on-demand registration
          // calls pi.registerProvider, the registry must find it — simulate
          // that by making find() return the model once registerProvider has
          // been called for openrouter with that model id in the models list.
          const modelsByRef: Record<string, any> = {
            'openrouter/test-vendor/fixture-model:free': freeModel,
          };
          let openrouterRegistered = false;
          const modelRegistry = {
            getAvailable: () => [freeModel],
            find: (provider: string, modelId: string) => {
              if (provider === 'openrouter' && openrouterRegistered) {
                return modelsByRef[`${provider}/${modelId}`] ?? null;
              }
              return null;
            },
            getApiKeyForProvider: async () => 'sk-or-test-fake-key',
            runtime: { streamSimple: vi.fn(() => (async function* () {
              yield { type: 'text_delta', delta: 'glm free model ok' };
              yield { type: 'done' };
            })()) },
          };
          // Hook: pi.registerProvider now flips openrouterRegistered in the
          // mock defined above (combined with the push), so subsequent find()
          // calls succeed — mirrors how Pi's real registry makes the model
          // findable after registration.
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'hi' }] };
          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          // No hard error — the cascade reached the free model.
          const errEvent = events.find((e: any) => e.type === 'error') as any;
          expect(errEvent).toBeUndefined();

          // The free model's content came through (not skipped as "not registered").
          const text = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');
          expect(text).toContain('glm free model ok');

          // And openrouter was registered on demand.
          const openrouterReg = registerProviderCalls.find((c) => c.name === 'openrouter');
          expect(openrouterReg).toBeDefined();
        }
      );
    }, 30000);

    it('does NOT overwrite a provider already registered with paid models (Ü1 invariant, roborev job 305)', async () => {
      await withIsolatedRouter(
        {
          free_models: [],
          providers: {
            openrouter: {
              free_models: ['openrouter/test-vendor/fixture-model:free', 'openrouter/some-paid-model'],
              keys: [{ key: 'sk-or-test-fake-key' }],
            },
          },
          model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
          gdpval_builtin: {
            'openrouter/test-vendor/fixture-model:free': 1000,
            'openrouter/some-paid-model': 950,
          },
        },
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

          // The provider is ALREADY registered (with a paid model) — simulating
          // registerGroupModels or another extension having done it. The
          // modelRegistry reports openrouter as a registered provider id AND
          // can find the paid model, but NOT the free model yet (find returns
          // null for the free ref until it's explicitly registered, which the
          // Ü1 guard must prevent from happening).
          const paidModel = { provider: 'openrouter', id: 'some-paid-model', api: 'openai-completions', contextWindow: 128_000 };
          const freeModel = { provider: 'openrouter', id: 'test-vendor/fixture-model:free', api: 'openai-completions', contextWindow: 128_000 };
          const modelRegistry = {
            getAvailable: () => [paidModel, freeModel],
            // Paid model is findable (already registered); free model is NOT
            // findable — so tryStream's `if (!realModel)` branch fires and
            // calls registerFreeModelOnDemand. The guard must then see
            // openrouter in getRegisteredProviderIds and bail, leaving the
            // paid model intact.
            find: (provider: string, modelId: string) =>
              modelId === 'some-paid-model' ? paidModel : null,
            getApiKeyForProvider: async () => 'sk-or-test-fake-key',
            // getRegisteredProviderIds is the authoritative 'is the provider known'
            // check used by the guard. openrouter IS registered → guard must bail.
            getRegisteredProviderIds: () => ['openrouter'],
            runtime: {
              streamSimple: vi.fn((model: any) => {
                if (model.id === 'some-paid-model') {
                  return (async function* () {
                    yield { type: 'text_delta', delta: 'paid model survived' };
                    yield { type: 'done' };
                  })();
                }
                return (async function* () {
                  yield { type: 'text_delta', delta: 'free model ok' };
                  yield { type: 'done' };
                })();
              }),
            },
          };
          const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          // The free model is NOT findable (not in the provider's registered
          // models list), so tryStream's on-demand guard fires — but it must
          // see openrouter as already registered and bail (not overwrite).
          // The cascade then falls over to the paid model, which IS findable.
          const groupModel = { provider: 'standard', id: 'standard' };
          const context: any = { messages: [{ role: 'user', content: 'hi' }] };
          const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

          // The on-demand registration must NOT have been called for openrouter
          // (the provider was already registered → Ü1 guard bailed).
          const openrouterReg = registerProviderCalls.find((c) => c.name === 'openrouter');
          expect(openrouterReg).toBeUndefined();

          // And the cascade must have fallen over to the paid model, which WAS
          // findable — proving the guard didn't break routing, just prevented
          // the wipe. (roborev job 313 LOW)
          const errEvent = events.find((e: any) => e.type === 'error') as any;
          expect(errEvent).toBeUndefined();
          const text = events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta ?? '')
            .join('');
          expect(text).toContain('paid model survived');
        }
      );
    }, 30000);
  });
});


describe('register-group-providers-label', () => {
  /**
   * Regression test: registerGroupProviders() used to call resolve() for
   * EVERY group, including method:'dynamic' ones. resolve() always returns
   * null for dynamic groups by design (they're resolved per-prompt by the
   * classifier hook inside groupStream, not statically at registration time)
   * — so the dynamic group's virtual model entry in Pi's model picker showed
   * the misleading label "dynamic → none", as if no model were available at
   * all.
   *
   * Fix: dynamic-method groups get a label that reflects what they actually
   * do ("auto-classify") instead of the resolve() result.
   */

  const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
  const dynamicConfigBackupPath = `${dynamicConfigPath}.label-test-bak`;
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

  describe('registerGroupProviders(): dynamic-method group labeling', () => {
    it('labels the dynamic group "auto-classify" instead of the misleading "→ none"', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-label-'));
      fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.pi', 'router-config.json'),
        JSON.stringify({
          free_models: [],
          model_groups: {
            standard: { fallback_groups: [], min_gdpval: 0 },
            dynamic: { method: 'dynamic', fallback_groups: [] },
          },
        })
      );
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      if (fs.existsSync(dynamicConfigPath)) fs.renameSync(dynamicConfigPath, dynamicConfigBackupPath);

      writeNoOpScanCache(scanCachePath); // make unawaited session_start scan() a no-op (root cause of the "No available models" CI flake)
      try {
        vi.resetModules();
        const mod = await import('../index.ts');
        const defaultExport = mod.default as any;

        const registerProvider = vi.fn();
        const pi: any = {
          registerTool: vi.fn(),
          registerCommand: vi.fn(),
          registerProvider,
          setModel: vi.fn(async () => true),
          on: vi.fn(),
        };
        defaultExport(pi);

        const dynamicCall = registerProvider.mock.calls.find((call: any[]) => call[0] === 'dynamic');
        expect(dynamicCall).toBeDefined();
        const models = dynamicCall![1].models;

        const mainEntry = models.find((m: any) => m.id === 'dynamic');
        expect(mainEntry.name).toBe('dynamic → auto-classify');
        expect(mainEntry.name).not.toContain('none');

        const staticFallbackEntry = models.find((m: any) => m.id === 'dynamic:use-static');
        expect(staticFallbackEntry).toBeDefined();
        expect(staticFallbackEntry.name).toBe('dynamic → auto-classify (static fallback allowed)');
        expect(staticFallbackEntry.name).not.toContain('none');

        // A non-dynamic group is unaffected: it still shows its resolved model
        // (or "none" if genuinely nothing resolved — that's the honest state
        // for a static group, unlike the dynamic group's classifier-at-runtime
        // design).
        const standardCall = registerProvider.mock.calls.find((call: any[]) => call[0] === 'standard');
        expect(standardCall).toBeDefined();
        const standardEntry = standardCall![1].models.find((m: any) => m.id === 'standard');
        expect(standardEntry.name).toMatch(/^standard → /);
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        // Flush any (currently nonexistent, but structurally possible) late
        // background-scan saveCache() BEFORE restoring the real cache — the
        // exact race flushBackgroundScan exists for (final v1.6.0 review minor #7).
        await flushBackgroundScan();
        removeNoOpScanCache(scanCachePath);

        if (fs.existsSync(dynamicConfigBackupPath)) fs.renameSync(dynamicConfigBackupPath, dynamicConfigPath);
      }
    });
  });
});


describe('register-group-providers-u1-guard', () => {
  /**
   * Final v1.6.0 review finding I3 (Important): registerGroupProviders
   * registered a virtual provider for EVERY configured model group without
   * ANY Ü1 guard — the comment claimed "Safe by construction (ADR-0019)",
   * but that only holds for the shipped group names (standard, strategic,
   * tactical, …). A user-defined group named "openai" (or any other pi
   * builtin provider id) would call pi.registerProvider('openai', { models:
   * [group model] }), and registerProvider REPLACES the provider's models
   * array wholesale (AGENTS.md §6 / Ü1) — wiping pi's ENTIRE openai model
   * catalog for the session.
   *
   * Pi's extension API offers no registry query at extension-load time (the
   * session_start re-register gets one via getRegisteredProviderIds, which
   * in 0.99.1 only lists extension-registered providers, NOT the builtins),
   * so the load-time guard is a static denylist of pi's builtin provider
   * ids (sourced from pi 0.99.1's defaultModelPerProvider catalog map) and
   * the session_start guard additionally refuses ids another extension
   * already registered.
   */

  const scanCachePath = path.join(
    process.env.PI_ROUTER_STATE_DIR!,
    '.cache',
    'scan-cache.json'
  );

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    registeredProviderIds: string[],
    fn: (registerProviderCalls: any[], onHandlers: Record<string, any>, ctx: any) => Promise<void>
  ) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-u1-guard-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify(configOverride)
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      const defaultExport = mod.default as any;

      const onHandlers: Record<string, Array<(ev: any, ctx: any) => any>> = {};
      const registerProviderCalls: any[] = [];
      const pi: any = {
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        registerProvider: vi.fn((name: string, opts: any) => {
          registerProviderCalls.push({ name, opts });
        }),
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
        getRegisteredProviderIds: () => registeredProviderIds,
        runtime: { streamSimple: vi.fn() },
      };
      const ctx: any = {
        modelRegistry,
        cwd: tmpDir,
        ui: { setFooter: vi.fn(), notify: vi.fn() },
      };
      await fn(registerProviderCalls, onHandlers, ctx);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      removeNoOpScanCache(scanCachePath);
    }
  }

  const baseConfig = {
    free_models: [],
    providers: { openrouter: { free_models: [] } },
    rate_limit_wait_max_ms: 0,
    model_groups: {
      // A group named like a pi BUILTIN provider — the Ü1 hazard (I3).
      openai: { fallback_groups: [], min_gdpval: 0 },
      standard: { fallback_groups: [], min_gdpval: 0 },
    },
  };

  describe('registerGroupProviders Ü1 guard', () => {
    it('never registers a group provider whose name is a pi builtin provider id', async () => {
      await withIsolatedRouter(baseConfig, [], async (registerProviderCalls) => {
        // Load-time registration happens during defaultExport(pi) already.
        const registeredNames = registerProviderCalls.map((c) => c.name);
        expect(registeredNames).toContain('standard');
        expect(registeredNames).not.toContain('openai');
      });
    });

    it('keeps refusing the builtin-named group across the session_start re-register', async () => {
      await withIsolatedRouter(
        baseConfig,
        [],
        async (registerProviderCalls, onHandlers, ctx) => {
          for (const h of onHandlers['session_start'] ?? []) await h({}, ctx);
          await flushBackgroundScan();
          const registeredNames = registerProviderCalls.map((c) => c.name);
          expect(registeredNames).toContain('standard');
          expect(registeredNames).not.toContain('openai');
        }
      );
    });

    it('still RE-registers its own groups at session_start even though they now appear in getRegisteredProviderIds', async () => {
      // In real pi, by the time session_start fires, getRegisteredProviderIds()
      // contains every provider WE registered at load time. A naive registry
      // guard ("skip if registered") would therefore skip the session_start
      // re-register for ALL groups — breaking the resolution-label refresh.
      // The guard must only refuse names the router itself did NOT register
      // (own-set tracking). A foreign-extension collision at load time is
      // genuinely undetectable: pi's extension API exposes no registry query
      // during extension load (see ADR-0019 § guard notes) — documented
      // limitation, not a test gap.
      await withIsolatedRouter(
        baseConfig,
        // Simulates the real session_start registry state: our own 'standard'
        // plus a foreign extension provider.
        ['standard', 'some-other-extension-provider'],
        async (registerProviderCalls, onHandlers, ctx) => {
          for (const h of onHandlers['session_start'] ?? []) await h({}, ctx);
          await flushBackgroundScan();
          const names = registerProviderCalls.map((c) => c.name);
          // 'standard' is ours — it MUST be re-registered (label refresh).
          expect(names.filter((n: string) => n === 'standard').length).toBeGreaterThanOrEqual(2);
          // The builtin-named group stays refused.
          expect(names).not.toContain('openai');
        }
      );
    });
  });
});


describe('mistral-zai-ghost-purge', () => {
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
   *      resurrected the ghosts before the fix). NOTE: since ADR-0021 the
   *      registration half of this assertion is trivially implied by
   *      test/adr-0021-no-unknown-model-registration.test.ts (the router
   *      registers no cloud provider, shadowed or not); this case keeps the
   *      end-to-end no-registration check for the incident's exact setup. The
   *      SCAN-side half of the ghost purge — shadowed alias entries never
   *      scanned, stale cache entries pruned — is covered by
   *      test/provider-shadow.test.ts (redundantAliasProviders /
   *      pruneRedundantCacheEntries) and the scan-skip in index.ts.
   *   2. pi does NOT know `mistral` either → mistral-zai must STILL not be
   *      registered. Before ADR-0021 the union registered it here as an
   *      "own-key fallback" — but under ADR-0021 (2026-10-02) the router
   *      never registers models Pi does not know, no matter what keys exist.
   *      If the user wants a provider pi does not ship, they register it in
   *      models.json; the router enriches but never invents.
   */

  async function withIsolatedRouter(
    configOverride: Record<string, unknown>,
    fn: (defaultExport: any, tmpDir: string) => Promise<void>
  ) {
    // Own state dir per router instance: the previous test's unawaited
    // background scan may still save its (pruned) cache when this one starts.
    const fileStateDir = process.env.PI_ROUTER_STATE_DIR!;
    const stateDir = fs.mkdtempSync(path.join(fileStateDir, 'instance-'));
    fs.mkdirSync(path.join(stateDir, '.cache'), { recursive: true });
    process.env.PI_ROUTER_STATE_DIR = stateDir;
    const dynamicConfigPath = path.join(stateDir, 'router-config.dynamic.json');
    const scanCachePath = path.join(stateDir, '.cache', 'scan-cache.json');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ghost-purge-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    const dynBak = `${dynamicConfigPath}.ghost-purge-bak`;
    const cacheBak = `${scanCachePath}.ghost-purge-bak`;
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
        // Numeric epoch ms (an ISO string is not a valid timestamp and made the
        // background scan regenerate and write into the next test).
        lastScanTimestamp: Date.now(),
        dynamic_config_expected: false,
        gdpval_scraped: true,
        models_cached: new Date().toISOString(),
      })
    );

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      await fn(mod.default as any, tmpDir);
    } finally {
      process.env.PI_ROUTER_STATE_DIR = fileStateDir;
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
      removeNoOpScanCache(scanCachePath);
      if (hadCache) fs.renameSync(cacheBak, scanCachePath);
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

    it('does NOT register the alias provider even when pi serves neither alias target nor source (ADR-0021)', async () => {
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
          // pi knows NOTHING about mistral. Before ADR-0021 the union
          // registered mistral-zai here as an "own-key fallback" (scan-discovered
          // models under an invented registration). ADR-0021: the router never
          // registers models Pi does not know — no fallback branch, no matter
          // what keys resolve.
          const ctx = buildCtx([]);
          await onHandlers['session_start']?.({}, ctx);
          await flushBackgroundScan();

          const registeredProviders = registerProviderCalls.map((c) => c.name);
          expect(registeredProviders).not.toContain('mistral-zai');
        }
      );
    });
  });
});
