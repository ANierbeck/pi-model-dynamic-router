// test/cost-report.test.ts
//
// Locks the /router cost report to the AUDIT DEPTH the owner approved
// (2026-09-27): ALL models of the session (not top-5) with in/out tokens,
// requests, marginal cost and billing tier (subscription marked as sunk —
// virtual prices, not real spend), plus persistent token windows
// 1d/7d/30d from usage_log with a blended-price estimate (honest: usage_log
// has only total tokens per request, so the estimate is labeled ≈ and uses
// (pIn+pOut)/2; unknown price → tokens only).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CostTracker } from '../src/cost-tracker.js';
import * as metricsModule from '../src/metrics.js';

vi.mock('../src/metrics.js', () => ({
  lookupPrice: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  routerLog: vi.fn(),
  writeLogLine: vi.fn(),
  appendRawLog: vi.fn(),
  setProjectLogDir: vi.fn(),
}));

const mockLookupPrice = vi.mocked(metricsModule.lookupPrice);

describe('CostTracker.formatCostReport', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    // Price map lives INSIDE beforeEach like cost-tracker.test.ts does
    // (review round 2, Finding 3: a describe-body-level implementation
    // survives clearAllMocks only by accident and would silently vanish on
    // a switch to resetAllMocks).
    mockLookupPrice.mockImplementation((ref: string) => {
      const priceMap: Record<string, { input: number; output: number }> = {
        'mistral/zai-glm-5-3': { input: 1.4, output: 4.4 },
        'claude-bridge/claude-opus-5-5': { input: 0.0000015, output: 0.0000015 },
        'mistral/mistral-medium-3.5': { input: 1.5, output: 7.5 },
        'ollama/gemma4:latest': { input: 0, output: 0 },
      };
      return priceMap[ref] ?? null;
    });
    // Clear the scheduled midnight-summary timer like cost-tracker.test.ts
    // does (review K2): harmless, but consistent test hygiene.
    tracker = new CostTracker('');
    tracker.resetMetrics();
  });

  afterEach(() => {
    // Clear the scheduled midnight-summary timer (review K2).
    tracker.dispose();
  });

  it('tracks per-model in/out tokens (tokensByModel)', () => {
    tracker.trackRequest('mistral/zai-glm-5-3', 1000, 200);
    tracker.trackRequest('mistral/zai-glm-5-3', 500, 300);
    tracker.trackRequest('ollama/gemma4:latest', 50, 10);
    const m = tracker.getMetrics();
    expect(m.tokensByModel['mistral/zai-glm-5-3']).toEqual({ in: 1500, out: 500 });
    expect(m.tokensByModel['ollama/gemma4:latest']).toEqual({ in: 50, out: 10 });
  });

  it('shows ALL models sorted by marginal cost desc, with tier labels and sunk markers', () => {
    tracker.trackRequest('mistral/zai-glm-5-3', 10_000, 2_000); // $0.0232
    tracker.trackRequest('claude-bridge/claude-opus-5-5', 5_000, 500); // sunk (virtual)
    tracker.trackRequest('mistral/mistral-medium-3.5', 1_000, 100); // $0.00225
    tracker.trackRequest('ollama/gemma4:latest', 800, 100); // $0

    const report = tracker.formatCostReport({
      billingTier: (ref) =>
        ref.startsWith('claude-bridge') ? 1 : ref.startsWith('ollama') ? 2 : ref.startsWith('mistral') ? 1 : 3,
      windowsAll: () => ({}),
      price: (ref) => mockLookupPrice(ref as string) ?? undefined,
    });

    // Header (total: glm $0.0228 + medium $0.00225 + opus sunk ≈$0 + gemma $0)
    expect(report).toMatch(/Cost Tracker \(Session,/);
    expect(report).toMatch(/Total: \$0\.02505/);

    // ALL models present (not top-5 truncated) — 4 distinct models
    expect(report).toContain('mistral/zai-glm-5-3');
    expect(report).toContain('claude-bridge/claude-opus-5-5');
    expect(report).toContain('mistral/mistral-medium-3.5');
    expect(report).toContain('ollama/gemma4:latest');

    // Sorted by marginal cost desc: glm-5-3 ($0.0232) before medium ($0.00225)
    // before opus (sunk, $0.0000075) before gemma ($0).
    const iGlm = report.indexOf('mistral/zai-glm-5-3');
    const iMedium = report.indexOf('mistral/mistral-medium-3.5');
    const iOpus = report.indexOf('claude-bridge/claude-opus-5-5');
    const iGemma = report.indexOf('ollama/gemma4:latest');
    expect(iGlm).toBeLessThan(iMedium);
    expect(iMedium).toBeLessThan(iOpus);
    expect(iOpus).toBeLessThan(iGemma);

    // Tier labels with sunk marker for subscription, local for ollama
    expect(report).toMatch(/sub \(sunk\)/);
    expect(report).toMatch(/local/);

    // Per-model token display in the session table
    expect(report).toMatch(/10\.0k\/2\.0k|10000\/2000/);
  });

  it('renders usage windows 1d/7d/30d with a blended ≈ estimate', () => {
    tracker.trackRequest('mistral/zai-glm-5-3', 1000, 200);

    const report = tracker.formatCostReport({
      billingTier: () => 1,
      windowsAll: () =>
        tracker.getMetrics().requestsByModel['mistral/zai-glm-5-3']
          ? { 'mistral/zai-glm-5-3': { d1: 9_900, d7: 20_200, d30: 20_200 } }
          : {},
      price: (ref) => mockLookupPrice(ref as string) ?? undefined,
    });

    expect(report).toMatch(/1d/);
    expect(report).toMatch(/7d/);
    expect(report).toMatch(/30d/);
    // tokens present
    expect(report).toContain('9.9k');
    expect(report).toContain('20.2k');
    // blended estimate over 30d: 20200 × (1.4+4.4)/2 / 1M = $0.0586
    expect(report).toMatch(/≈\$0\.0586/);
  });

  it('unknown price → windows show tokens only, no fabricated estimate', () => {
    tracker.trackRequest('some-unknown/model', 100, 20);
    const report = tracker.formatCostReport({
      billingTier: () => 3,
      windowsAll: () => ({ 'some-unknown/model': { d1: 500, d7: 500, d30: 500 } }),
      price: () => undefined,
    });
    expect(report).toContain('some-unknown/model');
    expect(report).toContain('500');
    // no estimate marker for the unknown model row
    expect(report).not.toMatch(/some-unknown\/model.*≈/);
  });

  it('empty session but persistent windows → windows visible right after restart (review I1)', () => {
    const report = tracker.formatCostReport({
      billingTier: () => 1,
      windowsAll: () => ({ 'mistral/zai-glm-5-3': { d1: 5_000, d7: 12_000, d30: 12_000 } }),
      price: (ref) => (ref === 'mistral/zai-glm-5-3' ? { input: 1.4, output: 4.4 } : undefined),
    });
    expect(report).toMatch(/No requests yet this session\./);
    // the persistent half must NOT be gated behind the session table
    expect(report).toContain('mistral/zai-glm-5-3');
    expect(report).toContain('12.0k');
  });

  it('completely empty (no session, no windows) → honest empty state', () => {
    const report = tracker.formatCostReport({
      billingTier: () => 0,
      windowsAll: () => ({}),
      price: () => undefined,
    });
    expect(report).toMatch(/No requests yet this session\./);
    expect(report).not.toMatch(/Windows/);
  });
});
