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
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/noop-scan-cache.ts';

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
