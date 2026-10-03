// test/claude-bridge-empty-response-narration.test.ts
// Regression test for the sourcelume 2026-10-03 finding: claude-bridge
// answers with an EMPTY response (stopReason 'stop', 0 chars) when the
// subscription spend limit is hit — there is no error text, no 429, and no
// reset time. The router narrated:
//
//   "> [router] claude-bridge/claude-opus-5-5 — empty response (likely
//    rate limit) (resets 10/3/2026, 12:23:53 PM), trying anthropic/…"
//
// Two lies in one line: it is a spend limit, not a rate limit, and the
// "resets" time is fabricated — the bridge never sent one, so the router
// rendered its OWN backoff end as if the provider had announced a reset.
//
// Honest behaviour (fixed):
//   - bridge refs are narrated as "empty response (likely subscription
//     spend limit)"
//   - a reset time is only shown when the provider actually sent one;
//     the router's own cooldown is narrated as "backing off until …".

import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/noop-scan-cache.ts';

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-bridge-empty-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.bridge-empty-bak`;
  const cacheBak = `${scanCachePath}.bridge-empty-bak`;
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

describe('claude-bridge empty response narration (spend limit, not rate limit)', () => {
  it('narrates the spend limit honestly: no rate-limit claim, no fabricated reset time', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: {},
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'claude-opus-5-5': 1000, 'next-model': 900 },
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

        // The exact sourcelume signature: bridge answers 'stop' with ZERO
        // content (the spend limit) — no error event, no reset time.
        const bridgeModel = {
          provider: 'claude-bridge',
          id: 'claude-opus-5-5',
          api: 'anthropic',
          contextWindow: 1_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        const nextModel = {
          provider: 'healthy-provider',
          id: 'next-model',
          api: 'openai-completions',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const modelsByRef: Record<string, any> = {
          'claude-bridge/claude-opus-5-5': bridgeModel,
          'healthy-provider/next-model': nextModel,
        };
        const streamSimple = vi.fn((model: any) => {
          if (model.provider === 'claude-bridge') {
            return (async function* () {
              yield { type: 'done' };
            })();
          }
          return (async function* () {
            yield { type: 'text_delta', delta: 'served by the next model' };
            yield { type: 'done' };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [bridgeModel, nextModel],
          find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'write the mailinglist text' }] };
        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        const text = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');

        // The cascade survived via the next model.
        expect(text).toContain('served by the next model');

        // Honest narration: spend limit, not rate limit …
        expect(text).toContain('claude-bridge/claude-opus-5-5 — empty response (likely subscription spend limit)');
        expect(text).not.toContain('(likely rate limit)');
        // … and no fabricated provider reset — only our own backoff, worded as such.
        expect(text).not.toMatch(/\(resets .+\)/);
        expect(text).toMatch(/\(backing off until .+\)/);
      }
    );
  }, 30000);
});
