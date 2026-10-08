/**
 * Integration + unit tests for the bounded wait-for-short-reset behavior
 * (ADR-0017) — born from the 2026-09-27 total-cooldown-collapse incident:
 *
 *   12:36:11  zai-glm-5-3 hit a real Mistral TPM limit with a KNOWN 60s reset.
 *             Instead of waiting, the cascade burned through every candidate,
 *             recording failures on all of them. Each subsequent request
 *             repeated the burn; the collapse branch then force-retried models
 *             whose OWN cooldown said "wait 28s" — guaranteed failures that
 *             extended the cooldowns. By 12:43 the router was fully dead while
 *             the API had recovered at 12:37. Hard-selecting the model worked,
 *             proving the state machine had diverged from reality.
 *
 * Guards implemented here:
 *  1. rate_limit with a KNOWN, NEAR reset → wait + retry the same model once
 *     (no chain-burn, next candidate never touched).
 *  2. rate_limit with a FAR reset (beyond rate_limit_wait_max_ms) → no wait,
 *     normal cascade to the next candidate.
 *  3. Total cooldown collapse with the shortest cooldown within the
 *     threshold → WAIT for it, then retry (no more force-retry into
 *     known-unexpired cooldowns).
 *  4. RateLimitManager.listLimits/clearAllLimits (backing /router cooldowns).
 */
import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeNoOpScanCache, removeNoOpScanCache, flushBackgroundScan } from './helpers/noop-scan-cache.ts';
import { RateLimitManager } from '../src/rate-limit.ts';

const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

/** Formats an absolute reset instant the way claude-bridge does (de-DE, Berlin
 * zone) — the format parseResetAtMs understands, including TZ correction. */
function formatResetAt(resetAtMs: number): string {
  return new Date(resetAtMs).toLocaleString('de-DE', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Europe/Berlin', timeZoneName: 'short',
  });
}

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  fn: (defaultExport: any, tmpDir: string) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-rlwait-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.rlwait-bak`;
  const cacheBak = `${scanCachePath}.rlwait-bak`;
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

/** Builds a mock modelRegistry whose streamSimple choreographs per-model
 * stream scripts. Each script entry is a list of events to yield (an error
 * event, or content + done). The model serves the NEXT script entry on each
 * call — falling back to the LAST entry once exhausted. */
function makeRegistry(modelsByRef: Record<string, any>) {
  const calls: string[] = [];
  const scripts: Record<string, AssistantMessageEvent[][]> = {};
  const modelList = Object.entries(modelsByRef).map(([ref, m]) => ({ ref, model: m }));

  const streamSimple = vi.fn((model: any) => {
    const ref = modelList.find((e) => e.model.id === model.id)!.ref;
    calls.push(ref);
    const script = scripts[ref] ?? [];
    const idx = calls.filter((c) => c === ref).length - 1;
    const events = idx < script.length ? script[idx] : script[script.length - 1] ?? [];
    return (async function* () {
      for (const ev of events) yield ev;
    })();
  });

  return {
    calls,
    scripts,
    registry: {
      getAvailable: () => modelList.map((e) => e.model),
      find: (provider: string, modelId: string) =>
        modelsByRef[`${provider}/${modelId}`] ?? null,
      getApiKeyForProvider: async () => null,
      runtime: { streamSimple },
    },
    streamSimple,
  };
}

function rateLimitErrorEvents(resetAtMs: number): AssistantMessageEvent[] {
  const resetStr = formatResetAt(resetAtMs);
  return [
    {
      type: 'error',
      reason: 'error',
      error: { message: `Warning: rate limit exceeded (tpm) — resets at ${resetStr}` },
    } as any,
  ];
}

function healthyEvents(text: string, stopReason: string = 'stop'): AssistantMessageEvent[] {
  return [
    { type: 'text_delta', contentIndex: 0, delta: text, partial: { role: 'assistant', content: [{ type: 'text', text }], stopReason } } as any,
    { type: 'done', reason: stopReason, message: { role: 'assistant', content: [{ type: 'text', text }], stopReason } } as any,
  ];
}

const baseCfg = {
  free_models: [],
  providers: { openrouter: { free_models: [] } },
  model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
  empty_response_timeout_ms: 5_000,
  reasoning_empty_response_timeout_ms: 5_000,
  stall_timeout_ms: 30_000,
};

describe('driveStream: bounded wait-for-short-reset', () => {
  it('waits for a near reset and retries the SAME model instead of cascading', async () => {
    await withIsolatedRouter(
      {
        ...baseCfg,
        gdpval_builtin: { 'limited-model': 1000, 'healthy-model': 900 },
        rate_limit_wait_max_ms: 4_000,
      },
      async (defaultExport) => {
        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(), registerCommand: vi.fn(), registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => { onHandlers[event] = handler; }),
        };
        defaultExport(pi);

        const limited = {
          provider: 'lim-provider', id: 'limited-model', api: 'lim-api',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const healthy = {
          provider: 'ok-provider', id: 'healthy-model', api: 'ok-api',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const mock = makeRegistry({
          'lim-provider/limited-model': limited,
          'ok-provider/healthy-model': healthy,
        });
        mock.scripts['lim-provider/limited-model'] = [
          rateLimitErrorEvents(Date.now() + 1500),  // first attempt: near reset (≥1.5s so second-truncation can't push it into the past)
          healthyEvents('served after wait'),       // retry: healthy
        ];

        const ctx: any = { modelRegistry: mock.registry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'do work' }] };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeUndefined();

        const text = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');

        // The narration must announce the wait (not a silent stall).
        expect(text).toContain('waiting');
        // The retried model's content made it through.
        expect(text).toContain('served after wait');
        // CRITICAL: the healthy fallback was NEVER touched — no chain-burn.
        expect(mock.calls.filter((c) => c === 'ok-provider/healthy-model')).toHaveLength(0);
        expect(mock.calls.filter((c) => c === 'lim-provider/limited-model')).toHaveLength(2);
      }
    );
  }, 30_000);

  it('does NOT wait for a far reset — cascades to the next candidate immediately', async () => {
    await withIsolatedRouter(
      {
        ...baseCfg,
        gdpval_builtin: { 'limited-model': 1000, 'healthy-model': 900 },
        rate_limit_wait_max_ms: 4_000,
      },
      async (defaultExport) => {
        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(), registerCommand: vi.fn(), registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => { onHandlers[event] = handler; }),
        };
        defaultExport(pi);

        const limited = {
          provider: 'lim-provider', id: 'limited-model', api: 'lim-api',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const healthy = {
          provider: 'ok-provider', id: 'healthy-model', api: 'ok-api',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const mock = makeRegistry({
          'lim-provider/limited-model': limited,
          'ok-provider/healthy-model': healthy,
        });
        mock.scripts['lim-provider/limited-model'] = [
          rateLimitErrorEvents(Date.now() + 60 * 60 * 1000), // 1h out — beyond threshold
        ];
        mock.scripts['ok-provider/healthy-model'] = [healthyEvents('served by the healthy fallback')];

        const ctx: any = { modelRegistry: mock.registry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'do work' }] };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeUndefined();

        const text = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');

        // No wait narration — immediate cascade.
        expect(text).not.toContain('waiting');
        expect(text).toContain('rate limit/spend limit reached');
        expect(text).toContain('served by the healthy fallback');
        expect(mock.calls.filter((c) => c === 'lim-provider/limited-model')).toHaveLength(1);
        expect(mock.calls.filter((c) => c === 'ok-provider/healthy-model')).toHaveLength(1);
      }
    );
  }, 30_000);

  it('collapse branch WAITS for the shortest cooldown instead of force-retrying into it', async () => {
    await withIsolatedRouter(
      {
        ...baseCfg,
        gdpval_builtin: { 'limited-model': 1000, 'second-model': 900 },
        rate_limit_wait_max_ms: 4_000,
        // Short rate-limit backoff so the collapse actually sees short
        // cooldowns (default first backoff is 60s — always beyond threshold).
        backoff_minutes: [0.02, 0.04],
        soft_backoff_ms: [1000, 2000],
      },
      async (defaultExport) => {
        const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
        const pi: any = {
          registerTool: vi.fn(), registerCommand: vi.fn(), registerProvider: vi.fn(),
          setModel: vi.fn(async () => true),
          on: vi.fn((event: string, handler: any) => { onHandlers[event] = handler; }),
        };
        defaultExport(pi);

        const limited = {
          provider: 'lim-provider', id: 'limited-model', api: 'lim-api',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const second = {
          provider: 'sec-provider', id: 'second-model', api: 'sec-api',
          contextWindow: 1_000_000, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        };
        const mock = makeRegistry({
          'lim-provider/limited-model': limited,
          'sec-provider/second-model': second,
        });
        mock.scripts['lim-provider/limited-model'] = [
          rateLimitErrorEvents(Date.now() + 1500), // near → wait-retry fires
          rateLimitErrorEvents(Date.now() + 1500), // retry fails again (reset now past) → cascade continues
        ];
        mock.scripts['sec-provider/second-model'] = [
          rateLimitErrorEvents(Date.now() + 1900),      // second candidate fails too (wait already used)
          healthyEvents('served after collapse wait'),  // collapse retry succeeds
        ];

        const ctx: any = { modelRegistry: mock.registry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'do work' }] };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeUndefined();

        const text = events
          .filter((e: any) => e.type === 'text_delta')
          .map((e: any) => e.delta ?? '')
          .join('');

        // Wait narration from the rate-limit branch AND the collapse branch.
        // The collapse assertion is branch-distinctive: 'All models in
        // cooldown' alone matched BOTH the wait and the force-retry
        // narration, so the wait guard was untested here (mutation R3:
        // every guard mutant that flips the branch passed vacuously —
        // closed by test/cooldown-collapse-retried-narration.test.ts).
        expect(text).toContain('waiting');
        expect(text).toContain('All models in cooldown — waiting');
        expect(text).not.toContain('All models in cooldown, retrying');
        // The collapse retry's content made it through.
        expect(text).toContain('served after collapse wait');
        // All four scripted streams were consumed (2× limited, 2× second).
        expect(mock.calls).toHaveLength(4);
      }
    );
  }, 30_000);
});

describe('RateLimitManager.listLimits / clearAllLimits (backing /router cooldowns)', () => {
  it('lists active cooldowns shortest-first and clears them all', () => {
    const mgr = new RateLimitManager([60_000], [30_000], 5, {} as any);
    const now = Date.now();
    mgr['limits'].set('prov/a', { cooldown_until: now + 5_000, backoff_ms: 60_000, hits: 1 });
    mgr['limits'].set('prov/b', { cooldown_until: now + 60_000, backoff_ms: 60_000, hits: 3, resetAtMs: now + 60_000 });
    mgr['limits'].set('prov/expired', { cooldown_until: now - 1_000, backoff_ms: 60_000, hits: 2 });

    const listed = mgr.listLimits();
    expect(listed).toHaveLength(2); // expired entry skipped
    expect(listed[0].ref).toBe('prov/a'); // shortest first
    expect(listed[1].ref).toBe('prov/b');
    expect(listed[1].hits).toBe(3);
    expect(listed[1].resetAtMs).toBeGreaterThan(now);

    const cleared = mgr.clearAllLimits();
    expect(cleared).toBe(3); // clears even expired entries
    expect(mgr.listLimits()).toHaveLength(0);
    expect(mgr.isLimited('prov/a')).toBe(false);
    expect(mgr.isLimited('prov/b')).toBe(false);
  });
});
