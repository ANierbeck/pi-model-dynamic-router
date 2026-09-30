// Final v1.6.0 review finding I2 (Important): the tool_result handler used
// a NAIVE rate-limit scan — `txt.includes('429')` matched ANY 429 substring
// ("1429 lines", a curl'd 429 from an unrelated host, test output) and
// attributed a hard cooldown + key rotation to the current model. It also
// called recordLimit DIRECTLY, bypassing recordStreamFailure — so genuine
// tool-shaped rate limits never reached the session_errors ring buffer
// (footer ⚠N err and /router errors missed them).
//
// This integration test drives the REAL extension through both halves of
// the fix: unified detection (isRateLimitText) and routing through
// recordStreamFailure (ring-buffer entry + consequence).

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
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

async function drainStream(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

describe('tool_result rate-limit detection', () => {
  it('records a genuine tool-result rate limit via the ring buffer', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/toolresult-rl-');
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        rate_limit_wait_max_ms: 0,
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'paid-model': 1000 },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      const defaultExport = mod.default as any;

      const onHandlers: Record<string, Array<(ev: any, ctx: any) => any>> = {};
      const pi: any = {
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
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
      // A SUCCESSFUL stream first — the handler attributes to curModel,
      // which is set when the router actually selected the model.
      const streamSimple = vi.fn(() =>
        (async function* () {
          yield { type: 'text_delta', delta: 'working on it' };
          yield { type: 'done' };
        })()
      );
      const modelRegistry = {
        getAvailable: () => [paidModel],
        find: (_p: string, modelId: string) => (modelId === 'paid-model' ? paidModel : null),
        getApiKeyForProvider: async () => null,
        runtime: { streamSimple },
      };
      const notify = vi.fn();
      const ctx: any = {
        modelRegistry,
        cwd: tmpDir,
        ui: { setFooter: vi.fn(), notify },
      };
      for (const h of onHandlers['session_start'] ?? []) await h({}, ctx);
      await flushBackgroundScan();
      // The tool_result handler attributes to the module-level curModel,
      // which pi sets on turn_start — fire it with the routed model.
      for (const h of onHandlers['turn_start'] ?? []) {
        await h({}, { ...ctx, model: paidModel });
      }
      await drainStream(
        defaultExport.groupStream(
          { provider: 'standard', id: 'standard' },
          { messages: [{ role: 'user', content: 'do the thing' }] } as any,
          {}
        )
      );
      expect(streamSimple).toHaveBeenCalled();

      // A tool fails with a genuine provider-shaped rate limit.
      for (const h of onHandlers['tool_result'] ?? []) {
        await h(
          {
            isError: true,
            content: [{ type: 'text', text: 'HTTP 429 Too Many Requests (rate limit exceeded)' }],
          },
          ctx
        );
      }

      for (const h of onHandlers['session_shutdown'] ?? []) await h({ reason: 'quit' });
      const persisted = JSON.parse(fs.readFileSync(scanCachePath, 'utf-8'));
      const entry = (persisted.session_errors ?? []).find(
        (e: any) => e.ref === 'paid-cloud-provider/paid-model' && e.reason === 'rate_limit_exceeded'
      );
      expect(entry).toBeDefined();
      expect(entry.detail).toContain('429');
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does NOT treat a bare "1429" in tool output as a rate limit', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/toolresult-norl-');
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        rate_limit_wait_max_ms: 0,
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'paid-model': 1000 },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    writeNoOpScanCache(scanCachePath);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      const defaultExport = mod.default as any;

      const onHandlers: Record<string, Array<(ev: any, ctx: any) => any>> = {};
      const pi: any = {
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
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
      const streamSimple = vi.fn(() =>
        (async function* () {
          yield { type: 'text_delta', delta: 'working on it' };
          yield { type: 'done' };
        })()
      );
      const modelRegistry = {
        getAvailable: () => [paidModel],
        find: (_p: string, modelId: string) => (modelId === 'paid-model' ? paidModel : null),
        getApiKeyForProvider: async () => null,
        runtime: { streamSimple },
      };
      const notify = vi.fn();
      const ctx: any = {
        modelRegistry,
        cwd: tmpDir,
        ui: { setFooter: vi.fn(), notify },
      };
      for (const h of onHandlers['session_start'] ?? []) await h({}, ctx);
      await flushBackgroundScan();
      for (const h of onHandlers['turn_start'] ?? []) {
        await h({}, { ...ctx, model: paidModel });
      }
      await drainStream(
        defaultExport.groupStream(
          { provider: 'standard', id: 'standard' },
          { messages: [{ role: 'user', content: 'do the thing' }] } as any,
          {}
        )
      );

      // Tool output containing a bare "1429" (e.g. "1429 lines matched") —
      // pre-fix, `txt.includes('429')` matched this and cooled the model down.
      for (const h of onHandlers['tool_result'] ?? []) {
        await h(
          {
            isError: true,
            content: [{ type: 'text', text: 'grep finished: 1429 lines matched in 12 files' }],
          },
          ctx
        );
      }

      // Non-vacuous half of the pin: the model must NOT be in cooldown.
      // Pre-fix, txt.includes('429') matched "1429 lines", recordLimit put
      // the model in a hard cooldown, and the next stream surfaced the
      // cooldown-collapse narration ("All models in cooldown …"). Post-fix
      // it streams cleanly. (streamSimple call count alone is NOT a valid
      // observable here — the collapse force-retries the single candidate,
      // so the count rises on both paths.)
      const events = await drainStream(
        defaultExport.groupStream(
          { provider: 'standard', id: 'standard' },
          { messages: [{ role: 'user', content: 'do the thing again' }] } as any,
          {}
        )
      );
      const allText = JSON.stringify(events);
      expect(allText).not.toContain('cooldown');

      for (const h of onHandlers['session_shutdown'] ?? []) await h({ reason: 'quit' });
      const persisted = JSON.parse(fs.readFileSync(scanCachePath, 'utf-8'));
      const entry = (persisted.session_errors ?? []).find(
        (e: any) => e.ref === 'paid-cloud-provider/paid-model' && e.reason === 'rate_limit_exceeded'
      );
      expect(entry).toBeUndefined();
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
