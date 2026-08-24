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
 * 25d7e93, but shipped without a regression test — this file closes that
 * gap). `empty_response_timeout_ms` / `reasoning_empty_response_timeout_ms`
 * were added later and needed the exact same fix (added alongside this
 * test).
 */
import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRouterStateLock, releaseRouterStateLock } from './helpers/router-state-lock.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dynamicConfigPath = path.join(repoRoot, 'router-config.dynamic.json');
const scanCachePath = path.join(repoRoot, '.cache', 'scan-cache.json');

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
  // Held until the finally block restores both shared files — see
  // router-state-lock.ts for why this must span the whole test.
  await acquireRouterStateLock();
  const hadDyn = fs.existsSync(dynamicConfigPath);
  const hadCache = fs.existsSync(scanCachePath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  if (hadCache) fs.renameSync(scanCachePath, cacheBak);

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
    if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    releaseRouterStateLock();
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
          provider: 'mistral',
          id: 'mistral-small-latest',
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
