// `/router` overview tables (src/overview-table.ts). Pure formatting: rows in,
// lines out: [header, separator, ...rows]. The regressions pinned here: unknown metrics were printed as if
// measured (gdp 50, latency 1000 ms, 100 tok/s defaults), units were missing,
// and the status column mixed "active" with the selection arrow.

import { describe, it, expect } from 'vitest';
import { formatOverviewTable, type OverviewRow } from '../src/overview-table.ts';

const row = (over: Partial<OverviewRow> = {}): OverviewRow => ({
  rank: 1,
  ref: 'mistral/zai-glm-5-3',
  gdpval: 1657.9,
  latencyMs: 812,
  tps: 395,
  price: '$1.4 / $4.4',
  usage: [10_942_300, 36_623_300, 303_130_400],
  budget: '',
  limited: false,
  limitSecs: 0,
  costMux: 1,
  current: false,
  ...over,
});

describe('formatOverviewTable — unknown values are not invented', () => {
  it('prints a dash for a GDPval that was never scraped, not the 50 default', () => {
    const body = formatOverviewTable([row({ gdpval: null, ref: 'ollama/gemma4:12b' })], 30)[2];
    expect(body).toMatch(/ollama\/gemma4:12b\s+–\s/);
    expect(body).not.toMatch(/\b50\b/);
  });

  it('prints a dash for latency and throughput with no completed stream yet', () => {
    const body = formatOverviewTable([row({ latencyMs: null, tps: null })], 30)[2];
    expect(body).not.toMatch(/\b1000\b/);
    expect(body).not.toMatch(/\b100\b/);
    expect(body.split('–').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('rounds a measured GDPval to an integer', () => {
    const body = formatOverviewTable([row({ gdpval: 1837.82 })], 30)[2];
    expect(body).toContain(' 1838 ');
  });
});

describe('formatOverviewTable — readable headers', () => {
  it('names the units in the header: ms, tok/s, $ per million tokens', () => {
    const [header] = formatOverviewTable([row()], 30);
    expect(header).toMatch(/Lat ms/);
    expect(header).toMatch(/tok\/s/);
    expect(header).toMatch(/\$\/M in\/out/);
  });

  it('labels the three usage columns as tokens used per window', () => {
    const [header] = formatOverviewTable([row()], 30);
    expect(header).toMatch(/use 1d\s+use 7d\s+use 30d/);
  });

  it('shows the budget column only when a row has a budget', () => {
    expect(formatOverviewTable([row()], 30)[0]).not.toMatch(/Budget/);
    expect(formatOverviewTable([row({ budget: '250m' })], 30)[0]).toMatch(/Budget/);
  });
});

describe('formatOverviewTable — status column', () => {
  it('marks the first choice and the current model with words, not arrows alone', () => {
    const lines = formatOverviewTable([row({ rank: 0, current: true })], 30);
    expect(lines[2]).toMatch(/first/);
    expect(lines[2]).toMatch(/current/);
  });

  it('explains the cost multiplier and the rate-limit wait', () => {
    const lines = formatOverviewTable([row({ rank: 3, costMux: 2, limited: true, limitSecs: 120 })], 30);
    expect(lines[2]).toMatch(/⛔ 120s/);
    expect(lines[2]).toMatch(/cost ×2/);
    expect(lines[2]).not.toMatch(/active/);
  });

  it('shows "ok" for a usable model that is neither first nor current', () => {
    const lines = formatOverviewTable([row({ rank: 2 })], 30);
    expect(lines[2].trimEnd().endsWith('ok')).toBe(true);
  });
});

describe('formatOverviewTable — width', () => {
  // The status is the last column and may run longer; the figures before it must fit.
  it('keeps the table within 110 columns with a budget column and a cost multiplier', () => {
    const lines = formatOverviewTable(
      [row({ ref: 'claude-bridge/' + 'x'.repeat(40), budget: '18000m', costMux: 2 })],
      30
    );
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(110);
  });
});

// A latency or throughput value counts as measured only after a stream of that
// model completed in this process; `getM` seeds placeholders before that.
describe('metrics — samples count the completed streams behind latency and tok/s', () => {
  it('has no samples before the first completed stream and one after it', async () => {
    const { getM, updateMetrics } = await import('../src/metrics.ts');
    const ref = 'overview-test/never-streamed';
    expect(getM(ref).samples ?? 0).toBe(0);
    updateMetrics(ref, 400, 200, 1000);
    expect(getM(ref).samples).toBe(1);
  });
});

describe('formatOverviewTable — ranking reason', () => {
  it('puts the reason in the status after "first", before limits', () => {
    const lines = formatOverviewTable(
      [row({ rank: 0, why: '−4.9% score, in window, cheaper', limited: true, limitSecs: 30 })],
      30
    );
    expect(lines[2]).toMatch(/first · −4\.9% score, in window, cheaper · ⛔ 30s/);
  });

  it('shows the reason instead of a bare "ok"', () => {
    const lines = formatOverviewTable([row({ rank: 1, why: '−0.9% score' })], 30);
    expect(lines[2].trimEnd().endsWith('−0.9% score')).toBe(true);
    expect(lines[2]).not.toMatch(/\bok\b/);
  });
});
