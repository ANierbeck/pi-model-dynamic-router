// Final v1.6.0 review, src finding S1 (Important): when ctx.tryStream
// THROWS (synchronous streamSimple throw, roborev job 302's error class),
// the catch block recorded a provider_error AND the `!target` block
// recorded a second, identical one. One real failure produced TWO
// session_errors entries — breaking the "footer count == buffer entries"
// 1:1 contract — and doubled the soft-failure hits cadence (backoff
// escalated one step too fast, costMuxAtHit reached after ~2 instead of
// ~4 real failures). This test pins EXACTLY ONE entry per thrown open
// failure. (The silent-null path — tryStream returning null with a
// skipReason — must still record its own single entry; both paths share
// the `!target` block, so the fix must not lose that one either.)
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeNoOpScanCache, removeNoOpScanCache, flushBackgroundScan } from './helpers/noop-scan-cache.ts';

// The test-suite runs with an isolated HOME + PI_ROUTER_STATE_DIR
// (test/setup/isolate-home.ts), so this points at the per-run temp dir.
// The cache lives under `.cache/` inside the state dir (STATE_FILES in
// package.json + src/cache.ts) — the same path session-errors-wiring.test.ts
// uses.
const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

async function drainStream(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('session_errors wiring: one thrown tryStream failure records exactly ONE entry', () => {
  it(
    'a synchronous streamSimple throw produces a single provider_error entry (not two)',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-errors-single-record-'));
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
      const dynBak = `${dynPath}.single-record-bak`;
      const hadDyn = fs.existsSync(dynPath);
      if (hadDyn) fs.renameSync(dynPath, dynBak);
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
        // Synchronous throw: tryStream re-throws it (job 302 path), so the
        // open fails via the CATCH branch — the exact double-record shape.
        const throwMsg = 'Unexpected status 500 from provider (boom)';
        const streamSimple = vi.fn(() => {
          throw new Error(throwMsg);
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

        await drainStream(
          defaultExport.groupStream(
            { provider: 'standard', id: 'standard' },
            { messages: [{ role: 'user', content: 'do the thing' }] } as any,
            {}
          )
        );
        expect(streamSimple).toHaveBeenCalled();

        for (const h of onHandlers['session_shutdown'] ?? []) await h({ reason: 'quit' });
        // Per-project instance state (2026-10-03): session_errors persist to
        // <cwd>/.pi/cache/router-state.json when the router runs with a
        // project scope.
        const persisted = JSON.parse(
          fs.readFileSync(path.join(tmpDir, '.pi', 'cache', 'router-state.json'), 'utf-8')
        );
        expect(Array.isArray(persisted.session_errors)).toBe(true);
        // THE pin: exactly one provider_error entry per REAL failed attempt.
        // streamSimple is called once per attempt (initial open + the
        // total-cooldown-collapse force-retry, which is a legitimate second
        // attempt and may record its own entry). The pre-fix code wrote one
        // entry per CODE PATH (catch + !target) for the SAME failure —
        // 3 entries for 2 attempts — breaking the footer "⚠N err == N
        // events" contract and doubling the soft-failure hits cadence.
        const entries = (persisted.session_errors as any[]).filter(
          (e) => e.ref === 'paid-cloud-provider/paid-model' && e.reason === 'provider_error'
        );
        expect(streamSimple.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(entries.length).toBe(streamSimple.mock.calls.length);
        for (const e of entries) expect(e.detail).toContain('500');
      } finally {
        cwdSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (hadDyn) fs.renameSync(dynBak, dynPath);
        else if (fs.existsSync(dynPath)) fs.rmSync(dynPath);
        removeNoOpScanCache();
      }
    }
  );
});
