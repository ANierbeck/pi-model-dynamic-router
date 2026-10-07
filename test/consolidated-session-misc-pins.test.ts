// test/consolidated-session-misc-pins.test.ts
// Consolidation of one-file-per-incident micro tests (suite hygiene round
// 2026-10-04): each former standalone file lives on as its own describe,
// named after the original file - failure output stays greppable. The
// tests themselves are UNCHANGED; hooks and fixtures moved verbatim.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  routerLog,
  setLogLevel,
  setProjectLogDir,
  configureLogRotation,
} from '../src/logger.ts';
import { serialized } from '../src/utils.ts';
import { writeNoOpScanCache, removeNoOpScanCache, flushBackgroundScan } from './helpers/noop-scan-cache.ts';
import { getUsage, getUsageAll, setCache } from '../src/metrics.ts';
import type { Cache } from '../src/types.ts';
import { fileURLToPath } from 'node:url';
import { readRouterVersion } from '../src/version.ts';

describe('global-log-tag', () => {
  /**
   * Live finding 2026-10-03: three concurrent pi instances (different
   * projects) interleave in the global ~/.pi/logs/router.log with no
   * provenance — correlation was only possible via timestamps. The
   * project-local mirror (<cwd>/.pi/logs/router.log) already exists.
   *
   * Fix (owner 2026-10-03): every line in the GLOBAL log carries a
   * [<project>/<pid>] tag after the timestamp; the project log stays
   * untagged; when both paths are identical (pi started in the home
   * directory) the line is written exactly once.
   */

  const homeLog = () => path.join(os.homedir(), '.pi', 'logs', 'router.log');
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '');
  const lastLine = (p: string) => read(p).trimEnd().split('\n').pop() ?? '';

  let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    fs.rmSync(path.dirname(homeLog()), { recursive: true, force: true });
    configureLogRotation({ maxBytes: 20 * 1024 * 1024, keep: 5 });
    setLogLevel('info');
  });

  afterEach(() => {
    setProjectLogDir(undefined);
    cwdSpy?.mockRestore();
    cwdSpy = undefined;
  });

  describe('global router.log provenance tag', () => {
    it('home lines carry [<project>/<pid>] after the timestamp; project lines stay untagged', () => {
      // Unique project dir (mutation R1 re-review m6): a fixed shared path is
      // the same parallel-safety class as the cache-per-project race, and a
      // leaked /tmp dir never gets cleaned up.
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-provenance-'));
      try {
        setProjectLogDir(projectDir);
        routerLog('[router] tagged check');
        const tag = `[${path.basename(projectDir)}/${process.pid}]`;
        expect(lastLine(homeLog())).toContain(tag);
        expect(lastLine(homeLog())).toContain('[router] tagged check');
        // ISO timestamp still leads the line (log tooling contract).
        expect(lastLine(homeLog())).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        const projLog = path.join(projectDir, '.pi', 'logs', 'router.log');
        expect(read(projLog)).not.toContain(tag);
      } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it('falls back to a [pi/<pid>] tag before session_start sets the project', () => {
      setProjectLogDir(undefined);
      routerLog('[router] early line');
      expect(lastLine(homeLog())).toContain(`[pi/${process.pid}]`);
    });

    it('writes exactly once when the project log dir IS the home log dir', () => {
      // Pi started directly in the home directory: both paths identical —
      // previously every line was appended twice.
      setProjectLogDir(os.homedir());
      routerLog('[router] dedupe check');
      const content = read(homeLog());
      const occurrences = content.split('[router] dedupe check').length - 1;
      expect(occurrences).toBe(1);
      // The single line still carries the provenance tag.
      expect(lastLine(homeLog())).toContain(`[${path.basename(os.homedir())}/${process.pid}]`);
    });
  });
});


describe('serialized', () => {
  // test/serialized.test.ts
  // generateDynamicConfig awaits an LLM call; a scan and the settled scan-sanity
  // re-check could overlap and both write router-config.dynamic.json, the slower
  // one last (review 2026-09-27). serialized() queues the runs.


  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  describe('serialized', () => {
    it('never overlaps runs and keeps call order', async () => {
      const events: string[] = [];
      let active = 0;
      let maxActive = 0;
      const run = serialized(async (name: string, ms: number) => {
        active++;
        maxActive = Math.max(maxActive, active);
        events.push(`start ${name}`);
        await tick(ms);
        events.push(`end ${name}`);
        active--;
      });
      await Promise.all([run('slow', 30), run('fast', 1)]);
      expect(maxActive).toBe(1);
      expect(events).toEqual(['start slow', 'end slow', 'start fast', 'end fast']);
    });

    it('a failed run rejects its own caller only and does not block the next', async () => {
      const run = serialized(async (fail: boolean) => {
        if (fail) throw new Error('boom');
      });
      const first = run(true);
      const second = run(false);
      await expect(first).rejects.toThrow('boom');
      await expect(second).resolves.toBeUndefined();
    });
  });
});


describe('session-errors-single-record', () => {
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
});


describe('session-errors-wiring', () => {
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
});


describe('usage-windows', () => {
  // test/usage-windows.test.ts
  //
  // The promised windows-boundary test from the plan (review I3: it was
  // missing, and its absence let the structurally-all-zero windows ship —
  // I1). Pins the REAL wiring basis: metrics.getUsage/getUsageAll over a
  // synthetic usage_log with entries at 1d/7d/30d boundaries, plus the
  // ref-space the /router cost windows are keyed by (REAL model refs, never
  // the virtual group refs the writer used before the I1 fix).


  const HOUR = 60 * 60 * 1000;
  const NOW = Date.now();

  function entry(ref: string, tokens: number, hoursAgo: number) {
    return { ref, tokens, ts: NOW - hoursAgo * HOUR };
  }

  describe('usage windows over a synthetic usage_log', () => {
    beforeEach(() => {
      setCache({
        usage_log: [
          entry('mistral/zai-glm-5-3', 100, 3), // < 1d
          entry('mistral/zai-glm-5-3', 200, 2 * 24), // 1d..7d
          entry('mistral/zai-glm-5-3', 400, 10 * 24), // 7d..30d
          entry('mistral/zai-glm-5-3', 800, 40 * 24), // > 30d — must drop
          entry('mistral/mistral-medium-3.5', 50, 5), // < 1d, second ref
          entry('ollama/gemma4:latest', 70, 25 * 24), // only in the 30d window
        ],
      } as Cache);
    });

    it('getUsage sums per ref inside the window and drops older entries', () => {
      // 1d: only the 3h-old entry
      expect(getUsage('mistral/zai-glm-5-3', 1)).toBe(100);
      // 7d: 3h + 48h entries
      expect(getUsage('mistral/zai-glm-5-3', 7)).toBe(300);
      // 30d: + the 10-day entry; the 40-day entry is gone
      expect(getUsage('mistral/zai-glm-5-3', 30)).toBe(700);
      // other refs stay separate
      expect(getUsage('mistral/mistral-medium-3.5', 1)).toBe(50);
      expect(getUsage('ollama/gemma4:latest', 7)).toBe(0);
      expect(getUsage('ollama/gemma4:latest', 30)).toBe(70);
    });

    it('getUsageAll returns per-ref maps per window — the windowsAll basis', () => {
      const d1 = getUsageAll(1);
      expect(d1).toEqual({ 'mistral/zai-glm-5-3': 100, 'mistral/mistral-medium-3.5': 50 });
      const d7 = getUsageAll(7);
      expect(d7['mistral/zai-glm-5-3']).toBe(300);
      expect(d7['ollama/gemma4:latest']).toBeUndefined();
      const d30 = getUsageAll(30);
      expect(d30).toEqual({
        'mistral/zai-glm-5-3': 700,
        'mistral/mistral-medium-3.5': 50,
        'ollama/gemma4:latest': 70,
      });
    });

    it('real model refs are the key space — a virtual group ref never matches', () => {
      // The pre-I1 writer keyed usage_log by ctx.model ('standard/standard');
      // window lookups by real refs were structurally all-zero. Pin the
      // ref-space contract the /router cost windows rely on.
      expect(getUsage('standard/standard', 30)).toBe(0);
      expect(getUsageAll(30)['standard/standard']).toBeUndefined();
    });
  });
});


describe('version', () => {
  describe('readRouterVersion', () => {
    it('returns a real version string, never "unknown"', () => {
      const v = readRouterVersion();
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
      expect(v).not.toBe('unknown');
    });

    it('matches the version field in the repo package.json', () => {
      // Cross-check against the package.json read from the test's own
      // location (also the repo root). If the relative path in version.ts
      // ever drifts, readRouterVersion falls back to 'unknown' and this fails.
      const pkg = JSON.parse(
        fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
      );
      expect(readRouterVersion()).toBe(pkg.version);
    });
  });
});
