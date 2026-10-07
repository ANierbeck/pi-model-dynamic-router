// test/provider-breaker-visibility.test.ts
// Phase 3 of the provider circuit breaker plan
// (docs/plans/2026-10-06-provider-circuit-breaker.md): breaker state is
// VOLATILE (stripped on save, ignored on merge — a restart is the standard
// remedy for a wedged provider and must never re-open a breaker the restart
// just fixed, plan D7) while the trip/hop telemetry PERSISTS; the /router
// overview shows every open breaker (cloud too, with counters) and
// `/router cooldowns clear` closes breakers as incident relief.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CacheManager } from '../src/cache.ts';
import {
  recordProviderFailure,
  recordProviderSuccess,
  recordBreakerSkip,
  isProviderOpen,
} from '../src/provider-breaker.ts';
import { recordLocalTimeout } from '../src/provider-watchdog.ts';
import { createCommands } from '../src/commands.ts';
import type { Cache } from '../src/types.ts';

// ── volatile state + persisted stats (plan D7) ──────────────────────────────

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-breaker-volatile-'));
const globalCache = () => path.join(stateDir, '.cache', 'scan-cache.json');
const readJson = (p: string): any => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {});
beforeEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

/** Cache with an open cloud breaker plus skip/trip telemetry, as a walk leaves it. */
function cacheWithOpenBreaker(): Cache {
  const cache: Cache = {};
  const t0 = Date.now() - 5_000;
  recordProviderFailure(cache, 'cloud-a/m1', 'empty_response', undefined, t0);
  recordProviderFailure(cache, 'cloud-a/m2', 'empty_response', undefined, t0 + 1);
  expect(recordProviderFailure(cache, 'cloud-a/m3', 'empty_response', undefined, t0 + 2)).toBe(true);
  recordBreakerSkip(cache, 'cloud-a');
  recordBreakerSkip(cache, 'cloud-a');
  expect(isProviderOpen(cache, 'cloud-a', t0 + 3)).toBe(true);
  return cache;
}

describe('breaker state is volatile, stats persist (plan D7)', () => {
  it('a save/load round trip drops the open breaker state but keeps provider_breaker_stats', () => {
    const mgr = new CacheManager(stateDir);
    const cache = mgr.getCache();
    recordProviderFailure(cache, 'cloud-a/m1', 'empty_response', undefined, 0);
    recordProviderFailure(cache, 'cloud-a/m2', 'empty_response', undefined, 1);
    recordProviderFailure(cache, 'cloud-a/m3', 'empty_response', undefined, 2);
    recordBreakerSkip(cache, 'cloud-a');
    mgr.saveCache();

    // The shared scan-cache file carries NO breaker state at all …
    expect(readJson(globalCache()).provider_breaker).toBeUndefined();
    expect(readJson(globalCache()).provider_breaker_stats?.['cloud-a']?.trips).toBe(1);

    // … so a fresh process (restart) starts with every breaker closed, while
    // the tuning evidence survives.
    const reloaded = new CacheManager(stateDir).getCache();
    expect(reloaded.provider_breaker).toBeUndefined();
    expect(isProviderOpen(reloaded, 'cloud-a')).toBe(false);
    expect(reloaded.provider_breaker_stats?.['cloud-a']).toEqual({
      trips: 1,
      avoided_hops: 1,
      last_trip_at: 2,
    });
  });

  it('a provider_breaker key written by an older version is ignored on load and merge, never resurrected', () => {
    // Pre-D7 cache file: an open breaker survived on disk.
    fs.mkdirSync(path.dirname(globalCache()), { recursive: true });
    fs.writeFileSync(globalCache(), JSON.stringify({
      provider_breaker: { 'cloud-a': { evidence: {}, open_until: Date.now() + 600_000, trip_count: 1 } },
      provider_breaker_stats: { 'cloud-a': { trips: 1, avoided_hops: 0 } },
    }));

    const mgr = new CacheManager(stateDir);
    const cache = mgr.getCache();
    // First load: the volatile key must not be adopted.
    expect(cache.provider_breaker).toBeUndefined();
    expect(isProviderOpen(cache, 'cloud-a')).toBe(false);
    // The stats ARE adopted.
    expect(cache.provider_breaker_stats?.['cloud-a']?.trips).toBe(1);

    // And a save must not write it back (memory is authoritative, so the
    // strip has to happen on the write path too).
    mgr.saveCache();
    expect(readJson(globalCache()).provider_breaker).toBeUndefined();
  });
});

// ── /router visibility (plan D6) ────────────────────────────────────────────

/**
 * Drives the real /router command handler (createCommands) with a minimal rt
 * object — the same harness as test/router-status-breaker-line.test.ts.
 */
async function runRouterCommand(cache: Cache, arg: string): Promise<string> {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = { registerCommand: (name: string, def: any) => { if (name === 'router') handler = def.handler; } };
  const rt: any = {
    pi,
    cache,
    cfg: { model_groups: {} },
    load: () => {},
    rateLimitManager: { getLimits: () => new Map(), clearAllLimits: () => 0 },
    isLimited: () => false,
    allDiscoveredRefs: () => [],
    curModel: '',
    sessionCtx: undefined,
    router: { setSessionCtx: () => {} },
    cacheManager: { saveCache: () => {} },
  };
  createCommands(rt);
  const notes: string[] = [];
  await handler!(arg, { ui: { notify: (m: string) => notes.push(m) } });
  return notes.join('\n');
}

describe('/router breaker visibility (plan D6)', () => {
  it('shows a CLOUD open breaker with remaining time and counters, not only local ones', async () => {
    const cache = cacheWithOpenBreaker();
    const out = await runRouterCommand(cache, '');
    const line = out.split('\n').find((l) => l.includes('cloud-a looks wedged')) ?? '';
    expect(line).toMatch(/skipped for \d+s/);
    expect(line).toContain('1 trip(s), 2 hop(s) avoided');
    // Generic fix hint for a cloud provider (ADR-0025 class A: no
    // provider-specific advice, and no daemon-restart advice off ollama).
    expect(line).toContain('check the provider/extension');
    expect(line).not.toContain('pkill');
  });

  it('shows the telemetry of a closed breaker too (tuning evidence, plan D7)', async () => {
    const cache: Cache = {};
    recordProviderFailure(cache, 'cloud-a/m1', 'empty_response', undefined, 0);
    recordProviderFailure(cache, 'cloud-a/m2', 'empty_response', undefined, 1);
    recordProviderFailure(cache, 'cloud-a/m3', 'empty_response', undefined, 2);
    recordProviderSuccess(cache, 'cloud-a/m1');
    expect(isProviderOpen(cache, 'cloud-a', 3)).toBe(false);
    const out = await runRouterCommand(cache, '');
    expect(out).toContain('cloud-a');
    expect(out).toContain('1 trip(s)');
    expect(out).not.toContain('looks wedged');
  });

  it('/router cooldowns clear closes open breakers (incident relief, no restart)', async () => {
    const cache = cacheWithOpenBreaker();
    // A local breaker too — both classes clear.
    recordLocalTimeout(cache, 'ollama/a', 0);
    recordLocalTimeout(cache, 'ollama/b', 1);
    expect(isProviderOpen(cache, 'ollama', 2)).toBe(true);

    const out = await runRouterCommand(cache, 'cooldowns clear');
    expect(isProviderOpen(cache, 'cloud-a', Date.now())).toBe(false);
    expect(isProviderOpen(cache, 'ollama', Date.now())).toBe(false);
    expect(out).toContain('breaker');
    // The telemetry survives the clear — only the open state is relief.
    expect(cache.provider_breaker_stats?.['cloud-a']?.trips).toBe(1);
  });
});
