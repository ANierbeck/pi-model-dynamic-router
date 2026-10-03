// test/session-errors-wiring.test.ts
//
// Review round 2, Finding 1 (IMPORTANT): the session_errors ring buffer
// documented "every main-session stream failure lands here" — but only the
// 4 rate-limit-shaped orchestrator sites routed through
// recordStreamFailure. Every OTHER main-loop soft failure (generic
// provider_error, stream-open failures, catch handler, repetition_loop,
// truncated_length, context overflow, force-retry softs) called
// recordSoftFailure DIRECTLY and bypassed the buffer. During exactly the
// failure cascades the feature was built to diagnose (the 2026-09-27
// direct-mistral 422 wave, timeout/empty-response waves) the status line
// showed ⚠0 err and /router errors reported "No errors recorded".
//
// This integration test drives the REAL extension (index.ts +
// StreamOrchestrator) through a plain, non-rate-limit provider_error —
// the previously-invisible case — and proves it lands in the persisted
// buffer with consequence 'soft backoff'.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/noop-scan-cache.ts';

const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');
// Per-project instance state (2026-10-03): session_errors persist here when
// the router runs with a project scope (process.cwd() during the test).
const projectStatePathFor = (cwd: string) => path.join(cwd, '.pi', 'cache', 'router-state.json');

async function drainStream(stream: AsyncIterable<any>) {
  const events: any[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

describe('session_errors wiring: main-loop SOFT failures reach the buffer', () => {
  it(
    'a plain provider_error (the 422-wave shape) is recorded with consequence "soft backoff"',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-errors-wiring-'));
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
      const dynPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
      const dynBak = `${dynPath}.wiring-bak`;
      const hadDyn = fs.existsSync(dynPath);
      if (hadDyn) fs.renameSync(dynPath, dynBak);
      // Minimal valid scan-cache so the unawaited session_start scan() no-ops
      // (see helpers/noop-scan-cache.ts) — same pattern as
      // orchestrator-router-context-freshness.test.ts.
      writeNoOpScanCache(scanCachePath);

      try {
        vi.resetModules();
        const mod = await import('../index.ts');
        const defaultExport = mod.default as any;

        // pi.on registers MULTIPLE handlers per event — the router registers
        // two session_shutdown handlers (persist + ctx-null). A naive
        // `map[event] = handler` harness keeps only the last one and silently
        // drops the persistence handler — store ARRAYS and fire them all.
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
        // A BARE provider error — no rate-limit wording, so it takes the
        // generic soft branch (the 2026-09-27 422-misclassification fix
        // deliberately made bare 422s soft).
        const streamSimple = vi.fn(() => {
          return (async function* () {
            yield { type: 'error', error: { errorMessage: 'Unexpected status 422 from provider (no body)' } };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [paidModel],
          find: (_provider: string, modelId: string) => (modelId === 'paid-model' ? paidModel : null),
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
        for (const h of onHandlers['session_start'] ?? []) await h({}, ctx);
        await flushBackgroundScan();

        // Before the Finding-1 fix this failure was invisible to the buffer
        // (recordSoftFailure direct call): ⚠0 err during the exact cascade
        // the feature was built to diagnose.
        await drainStream(
          defaultExport.groupStream(
            { provider: 'standard', id: 'standard' },
            { messages: [{ role: 'user', content: 'do the thing' }] } as any,
            {}
          )
        );
        expect(streamSimple).toHaveBeenCalled();

        // Flush the debounced save via the shutdown handler, then read the
        // persisted buffer from the scan cache (the single source of truth).
        for (const h of onHandlers['session_shutdown'] ?? []) await h({ reason: 'quit' });
        const persisted = JSON.parse(fs.readFileSync(projectStatePathFor(tmpDir), 'utf-8'));
        expect(Array.isArray(persisted.session_errors)).toBe(true);
        expect(persisted.session_errors.length).toBeGreaterThan(0);
        const entry = persisted.session_errors.find(
          (e: any) => e.ref === 'paid-cloud-provider/paid-model' && e.reason === 'provider_error'
        );
        expect(entry).toBeDefined();
        expect(entry.consequence).toBe('soft backoff');
        expect(entry.detail).toContain('422');
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (hadDyn) fs.renameSync(dynBak, dynPath);
        removeNoOpScanCache(scanCachePath);
      }
    },
    30000
  );
});
