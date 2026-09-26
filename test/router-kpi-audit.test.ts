// test/router-kpi-audit.test.ts
// The KPI audit parses real router.log line shapes (verbatim samples).

import { describe, it, expect } from 'vitest';
import { createKpis, ingestLine, formatReport, parseSince } from '../scripts/router-kpi-audit.ts';

const LINES = [
  '2026-09-26T16:00:00.000Z  [delegation] replaced 21000-char read result with 65-char summary via bulk_reader',
  '2026-09-26T16:00:01.000Z  [delegation] replaced 6533-char bash result with 6936-char summary via bulk_reader',
  '2026-09-26T16:31:08.223Z  [delegation] failed, passing through: sub-model stream error: [object Object]',
  '2026-09-26T18:04:25.418Z  [delegation] sub-call produced no usable summary (26 chars) — passing through',
  '2026-09-26T18:05:00.000Z  [bulk_read] blocked a full-file read by expensive model "pi-claude/claude-opus-5" — redirected to bulk_read/targeted read',
  '2026-09-26T18:05:01.000Z  [bulk_read] blocked a full-file read of "src/x.ts" — redirected to bulk_read/targeted read',
  '2026-09-26T21:34:01.979Z  [router] ollama/gemma4:12b-mlx — no response within timeout, trying ollama/ornith:9b …',
  '2026-09-26T21:35:00.000Z  [router] openrouter/thinkingmachines/inkling:free — provider error: 403: {"message":"x","code":403}, trying mistral/a …',
  '2026-09-26T21:36:00.000Z  [router] mistral/mistral-small-latest — rate limit/spend limit reached (resets 23:00)',
  '2026-09-26T21:37:00.000Z  [router] All 47 candidate(s) failed for group standard',
  '2026-09-26T21:38:00.000Z  [router] openrouter/thinkingmachines/inkling:free blocked for 7 days: agentic-harness-gate (HTTP 403, signature 403:agentic-harness-gate, seen 1×)',
  '2026-09-26T21:39:00.000Z  [router] openrouter/x/y answered after its blocklist entry expired — block cleared',
  '2026-09-26T21:40:00.000Z  [router] watchdog: ollama looks wedged — skipping its models for 5 min',
  '2026-09-26T21:40:01.000Z  [classifier] Ollama marked wedged by the watchdog — skipping both local models',
  '2026-09-26T21:31:56.932Z  [classifier] Primary model "gemma4:12b-mlx" rejects structured output (501) — marked in cache, retrying with gemma2:2b',
  '2026-09-26T21:41:00.000Z  [classifier] Fallback model also failed no response within timeout',
  '2026-09-02T20:47:50.328Z  code_complex → tactical  pi-claude/claude-sonnet-5  "hey what did you spot"',
  'continuation line without a timestamp',
];

describe('router KPI audit', () => {
  it('aggregates every KPI family from real line shapes', () => {
    const k = createKpis();
    for (const l of LINES) ingestLine(k, l);
    expect(k.lines).toBe(LINES.length - 1);
    expect(k.delegation).toMatchObject({
      replaced: 2, byTool: { read: 1, bash: 1 }, charsIn: 27533, charsOut: 7001,
      inflated: 1, failed: 1, noUsableSummary: 1,
    });
    expect(k.readBlocks).toEqual({ expensive: 1, size: 1 });
    expect(k.hops.failures).toBe(3);
    expect(k.hops.byReason).toEqual({ timeout: 1, provider_error: 1, rate_limit: 1 });
    expect(k.hops.byModel['openrouter/thinkingmachines/inkling:free']).toBe(1);
    expect(k.allCandidatesFailed).toBe(1);
    expect(k.blocklist).toEqual({ blocked: 1, byReason: { 'agentic-harness-gate': 1 }, cleared: 1 });
    expect(k.watchdog).toEqual({ wedged: 1, classifierSkips: 1 });
    expect(k.classifier).toEqual({ byCategory: { code_complex: 1 }, noSchema501: 1, fallbackFailed: 1 });
    expect(formatReport(k)).toContain('saved 20532, 75%');
  });

  it('skips lines before --since', () => {
    const k = createKpis();
    for (const l of LINES) ingestLine(k, l, Date.parse('2026-09-26T21:00:00Z'));
    expect(k.classifier.byCategory).toEqual({});
    expect(k.delegation.replaced).toBe(0);
    expect(k.hops.failures).toBe(3);
  });

  it('parses relative and absolute --since values', () => {
    const now = Date.parse('2026-09-27T00:00:00Z');
    expect(parseSince('7d', now)).toBe(now - 7 * 86_400_000);
    expect(parseSince('24h', now)).toBe(now - 86_400_000);
    expect(parseSince('2026-09-20', now)).toBe(Date.parse('2026-09-20'));
    expect(() => parseSince('soon', now)).toThrow(/cannot parse/);
  });
});
