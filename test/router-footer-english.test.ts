// /router group-table footer must be English (AGENTS.md §3: documentation and
// comments English-only; owner decision 2026-10-07 extended that to the TUI
// strings). The footer used to read "… +N weitere (sortiert nach <method>)".
// No test pinned the string, so the German text survived the v1.4.0-era
// translation round. This drives the real /router overview handler and pins
// the English footer.

import { describe, it, expect } from 'vitest';
import { createCommands } from '../src/commands.ts';
import type { Cache } from '../src/types.ts';

async function renderOverview(cache: Cache): Promise<string> {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = { registerCommand: (name: string, def: any) => { if (name === 'router') handler = def.handler; } };
  const rt: any = {
    pi,
    cache,
    cfg: {
      model_groups: {
        scout: { description: 'Scout', method: 'roundrobin', fallback_groups: [] },
      },
    },
    load: () => {},
    rateLimitManager: { getLimits: () => new Map() },
    isLimited: () => false,
    allDiscoveredRefs: () => [],
    curModel: '',
    sessionCtx: undefined,
    router: { setSessionCtx: () => {} },
    // 6 candidates, top-5 shown -> footer must report +1 more.
    getTopModels: (_groupName: string, n: number) => ({
      models: Array.from({ length: Math.min(n, 6) }, (_, i) => ({
        ref: `prov/m${i}`, limited: false, rank: i,
      })),
      total: 6,
    }),
    // Minimal per-model helpers used by the table rows; the footer only
    // needs the loop to complete.
    getM: (ref: string) => ({ ref, gdpval: 500, avg_latency_ms: 500, throughput_tps: 10 }),
    costMux: () => 1,
    effCost: () => 0,
    lookupListPrice: () => null,
    lookupPrice: () => null,
    limitSecs: () => 0,
    getUsage: () => ({} as any),
  };
  createCommands(rt);
  const notes: string[] = [];
  await handler!('', { ui: { notify: (m: string) => notes.push(m) } });
  return notes.join('\n');
}

describe('/router group-table footer', () => {
  it('renders the "more models" footer in English', async () => {
    const out = await renderOverview({});
    expect(out).toContain('… +1 more (sorted by roundrobin)');
    expect(out).not.toContain('weitere');
  });
});
