// test/cache-warm-cost.test.ts
// docs/plans/2026-11-20-honor-pi-cache-warming.md, decision O1: Pi's cache
// warms show in `/router cost` as their own line, read from Pi's `cache_warm`
// usage entries (Pi's record is the source). They stay out of the router's
// session Total — turn statistics count only routed requests.

import { describe, it, expect } from 'vitest';
import { CostTracker } from '../src/cost-tracker.ts';
import { cacheWarmTotals } from '../src/cache-warming.ts';
import { registerRouterCommand, runRouterCommand } from './helpers/router-command.ts';

const warm = (cost: number, cacheRead = 120_000): any => ({
  type: 'usage',
  kind: 'cache_warm',
  id: `w${cost}`,
  parentId: null,
  timestamp: new Date().toISOString(),
  provider: 'p',
  model: 'm',
  usage: {
    input: 0,
    output: 1,
    cacheRead,
    cacheWrite: 0,
    totalTokens: cacheRead + 1,
    cost: { input: 0, output: 0, cacheRead: cost, cacheWrite: 0, total: cost },
  },
});

const deps = {
  billingTier: (): number => 3,
  windowsAll: (): Record<string, { d1: number; d7: number; d30: number }> => ({}),
  price: (): undefined => undefined,
};

describe('cacheWarmTotals', () => {
  it('sums only Pi’s cache_warm usage entries', () => {
    const entries = [
      warm(0.03),
      warm(0.02, 80_000),
      { ...warm(9), kind: 'other' },
      { type: 'message', message: { role: 'assistant' } },
    ];
    const t = cacheWarmTotals(entries);
    expect(t.count).toBe(2);
    expect(t.cost).toBeCloseTo(0.05);
    expect(t.cacheRead).toBe(200_000);
    expect(t.output).toBe(2);
  });

  it('no entries → zero totals', () => {
    expect(cacheWarmTotals(undefined).count).toBe(0);
  });
});

describe('/router cost shows Pi’s cache warms on their own line', () => {
  it('lists count, cost and cache reads, outside the session Total', () => {
    const tracker = new CostTracker();
    tracker.trackRequest('p/m', 1000, 100);
    const report = tracker.formatCostReport({
      ...deps,
      cacheWarms: cacheWarmTotals([warm(0.03), warm(0.02, 80_000)]),
    });
    expect(report).toMatch(
      /Cache warms \(Pi\): 2, \$0\.0500 \(cache read 200\.0k\) — not in Total/
    );
  });

  it('no warms → no line', () => {
    const tracker = new CostTracker();
    const report = tracker.formatCostReport({ ...deps, cacheWarms: cacheWarmTotals([]) });
    expect(report).not.toContain('Cache warms');
  });

  it('the /router cost command reads the warms from the session', async () => {
    const router = registerRouterCommand({ lookupPrice: () => undefined });
    const notes = await runRouterCommand(router, 'cost', {
      sessionManager: { getEntries: () => [warm(0.04)] },
    });
    expect(notes.join('\n')).toMatch(/Cache warms \(Pi\): 1, \$0\.0400/);
  });
});
