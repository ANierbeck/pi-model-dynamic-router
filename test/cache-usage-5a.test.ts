// test/cache-usage-5a.test.ts
// Phase 5a of docs/plans/2026-10-05-task-type-balancing.md (measure, always
// on): the usage_log recorded input+output only, but providers report the
// bulk of a long agentic context as cacheRead/cacheWrite (live finding:
// input 2-3k vs cacheRead 50k+ per step, i.e. ~40x undercounted), so the
// /router cost windows were structurally far too low and no cache hit rate
// was observable. A usage with cacheRead MUST be counted, and the cache
// share must be derivable per step, per window and in the footer.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  stepContextTokens,
  stepCacheShare,
  buildUsageLogEntry,
  formatCacheStatus,
} from '../src/cache-stats.js';
import { setCache, getUsage, getUsageAll, getCacheUsageAll } from '../src/metrics.js';
import { CostTracker } from '../src/cost-tracker.js';

const warm = { input: 2, output: 163, cacheRead: 50120, cacheWrite: 3322, cost: { total: 0 } };
const cold = { input: 105189, output: 400, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } };

describe('step helpers', () => {
  it('context = input + cacheRead + cacheWrite (everything the model read)', () => {
    expect(stepContextTokens(warm)).toBe(2 + 50120 + 3322);
    expect(stepContextTokens(cold)).toBe(105189);
  });

  it('cache share = cacheRead / context, null on an empty context', () => {
    expect(stepCacheShare(warm)).toBeCloseTo(50120 / 53444, 5);
    expect(stepCacheShare(cold)).toBe(0);
    expect(stepCacheShare({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
});

describe('buildUsageLogEntry', () => {
  it('counts cacheRead and cacheWrite in tokens and records them separately', () => {
    const e = buildUsageLogEntry('claude-bridge/claude-opus-5-5', warm, 1234)!;
    expect(e.tokens).toBe(2 + 163 + 50120 + 3322);
    expect(e.cacheRead).toBe(50120);
    expect(e.cacheWrite).toBe(3322);
    expect(e.ref).toBe('claude-bridge/claude-opus-5-5');
    expect(e.ts).toBe(1234);
  });

  it('omits the cache fields for providers that report none (entry stays small)', () => {
    const e = buildUsageLogEntry('mistral/x', { input: 10, output: 5 }, 1)!;
    expect(e).toEqual({ ref: 'mistral/x', tokens: 15, ts: 1 });
  });

  it('returns null when the provider reported no usage at all', () => {
    expect(buildUsageLogEntry('mistral/x', { input: 0, output: 0 }, 1)).toBeNull();
    expect(buildUsageLogEntry('mistral/x', undefined, 1)).toBeNull();
  });
});

describe('cost windows count cache tokens', () => {
  const NOW = Date.now();
  beforeEach(() => {
    setCache({
      usage_log: [
        { ref: 'a/m', tokens: 53687, cacheRead: 50120, cacheWrite: 3322, ts: NOW - 1000 },
        { ref: 'a/m', tokens: 1000, ts: NOW - 2000 }, // legacy entry without cache fields
      ],
    } as any);
  });

  it('getUsage / getUsageAll include the cache tokens', () => {
    expect(getUsage('a/m', 1)).toBe(54687);
    expect(getUsageAll(1)).toEqual({ 'a/m': 54687 });
  });

  it('getCacheUsageAll aggregates cacheRead per ref and window (legacy entries add 0)', () => {
    expect(getCacheUsageAll(1)).toEqual({ 'a/m': { cacheRead: 50120, cacheWrite: 3322 } });
  });
});

describe('/router cost report shows cache', () => {
  it('session total and window rows carry the cache share', () => {
    const t = new CostTracker();
    t.trackRequest('a/m', 2, 163, 50120, 3322);
    t.trackRequest('a/m', 2, 100, 0, 0);
    const report = t.formatCostReport({
      billingTier: () => 1,
      windowsAll: () => ({ 'a/m': { d1: 54687, d7: 54687, d30: 54687, cacheRead30: 50120 } }),
      price: () => undefined,
    });
    // Session total: cacheRead 50120 of context (2+2+50120+3322) = 94%.
    expect(report).toContain('cache read 50.1k (94%)');
    // Window row: cacheRead30 50120 of 54687 window tokens = 92%.
    expect(report).toMatch(/Cache30d/);
    expect(report).toMatch(/a\/m\s+54\.7k\s+54\.7k\s+54\.7k\s+92%/);
  });
});

describe('footer segment', () => {
  it('formats context, cache share and average step cost', () => {
    const s = formatCacheStatus(warm, 4, 0.12);
    expect(s).toBe('ctx 53.4k · cache 94% · ~$0.03/step');
  });

  it('omits the cost part when nothing was billed (subscription / free)', () => {
    expect(formatCacheStatus(warm, 4, 0)).toBe('ctx 53.4k · cache 94%');
  });

  it('shows a cold step as 0%', () => {
    expect(formatCacheStatus(cold, 1, 0.05)).toBe('ctx 105.2k · cache 0% · ~$0.05/step');
  });

  it('is empty before the first step', () => {
    expect(formatCacheStatus(undefined, 0, 0)).toBe('');
  });
});

describe('window price estimate excludes cache reads', () => {
  it('prices only the non-cacheRead tokens (cached reads are billed far below list)', () => {
    const t = new CostTracker();
    t.trackRequest('a/m', 10, 5);
    const report = t.formatCostReport({
      billingTier: () => 0,
      windowsAll: () => ({ 'a/m': { d1: 0, d7: 0, d30: 1_000_000, cacheRead30: 900_000 } }),
      price: () => ({ input: 2, output: 2 }),
    });
    // (1_000_000 - 900_000) tokens at $2/M = $0.2000, not $2.0000.
    expect(report).toContain('≈$0.2000');
  });
});
