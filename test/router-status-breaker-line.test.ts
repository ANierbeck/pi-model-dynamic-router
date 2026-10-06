// /router overview: an open provider breaker must still surface as the
// "looks wedged" warning. The line used to read cache.local_provider_health
// directly; once provider-watchdog became a shim over provider-breaker (state
// in cache.provider_breaker) nothing wrote that key any more and the warning
// disappeared silently — no test covered it. This drives the real overview
// handler through a breaker opened by the shim API.

import { describe, it, expect } from 'vitest';
import { createCommands } from '../src/commands.ts';
import { recordLocalTimeout, WEDGE_COOLDOWN_MS } from '../src/provider-watchdog.ts';
import type { Cache } from '../src/types.ts';

async function renderOverview(cache: Cache): Promise<string> {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = { registerCommand: (name: string, def: any) => { if (name === 'router') handler = def.handler; } };
  const rt: any = {
    pi,
    cache,
    cfg: { model_groups: {} },
    load: () => {},
    rateLimitManager: { getLimits: () => new Map() },
    isLimited: () => false,
    allDiscoveredRefs: () => [],
    curModel: '',
    sessionCtx: undefined,
    router: { setSessionCtx: () => {} },
  };
  createCommands(rt);
  const notes: string[] = [];
  await handler!('', { ui: { notify: (m: string) => notes.push(m) } });
  return notes.join('\n');
}

describe('/router overview wedge line', () => {
  it('shows an open local-provider breaker with its remaining time and fix hint', async () => {
    const cache: Cache = {};
    const now = Date.now();
    recordLocalTimeout(cache, 'ollama/model-a', now);
    expect(recordLocalTimeout(cache, 'ollama/model-b', now)).toBe(true);
    const out = await renderOverview(cache);
    const line = out.split('\n').find((l) => l.includes('looks wedged')) ?? '';
    expect(line).toContain('ollama looks wedged');
    expect(line).toMatch(new RegExp(`skipped for (${WEDGE_COOLDOWN_MS / 1000}|${WEDGE_COOLDOWN_MS / 1000 - 1})s`));
    expect(line).toContain('pkill ollama');
  });

  it('shows no wedge line while no breaker is open', async () => {
    const out = await renderOverview({});
    expect(out).not.toContain('looks wedged');
  });
});
