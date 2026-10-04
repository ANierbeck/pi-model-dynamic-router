import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { calculateScore, setConfig, setCache, setGdpval } from '../src/metrics.js';

describe('calculateScore', () => {
  beforeEach(() => {
    setConfig({
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: {
        'claude-3-sonnet': 680,
        'claude-4-sonnet': 720,
        'devstral-medium-2507': 691,
        'codestral-latest': 520,
      },
    });
    setCache({});
    setGdpval({
      'claude-3-sonnet': 680,
      'claude-4-sonnet': 720,
      'devstral-medium-2507': 691,
      'codestral-latest': 520,
    });
  });

  afterEach(() => {
    setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
    setCache({});
    setGdpval({});
  });

  test('returns GDPval unchanged (no normalization/cap)', () => {
    expect(calculateScore('anthropic/claude-4-sonnet')).toBeCloseTo(720);
    expect(calculateScore('anthropic/claude-3-sonnet')).toBeCloseTo(680);
    expect(calculateScore('mistral/devstral-medium-2507')).toBeCloseTo(691);
    expect(calculateScore('mistral/codestral-latest')).toBeCloseTo(520);
  });

  // ADR-0023 round 2 (2026-10-04): the second argument is now the group's
  // score_by COLUMN and DOES affect the score when a capability profile
  // exists. This test pins the two halves of that contract that live in
  // this file's gdpval-only fixture:
  //   1. legacy/unknown column strings ('code', 'standard', a group name
  //      passed by pre-round callers) fall back to gdpval — byte-for-byte
  //      the pre-round behavior;
  //   2. a real column ('briefcase'/'coding') with NO profile in the cache
  //      also falls back to gdpval (fail-closed — null is the fallback
  //      signal, never 0).
  // The positive case (column changes the score when a profile exists) is
  // pinned in aa-capability-sourcing.test.ts, which imports this same
  // production function with a profile-bearing fixture.
  test('column argument falls back to gdpval without a profile (legacy strings and real columns alike)', () => {
    const base = calculateScore('mistral/codestral-latest');
    expect(calculateScore('mistral/codestral-latest', 'code')).toBe(base);
    expect(calculateScore('mistral/codestral-latest', 'standard')).toBe(base);
    expect(calculateScore('mistral/codestral-latest', 'briefcase')).toBe(base);
    expect(calculateScore('mistral/codestral-latest', 'coding')).toBe(base);
  });

  test('higher GDPval produces higher score', () => {
    expect(calculateScore('anthropic/claude-4-sonnet')).toBeGreaterThan(
      calculateScore('anthropic/claude-3-sonnet')
    );
    expect(calculateScore('mistral/devstral-medium-2507')).toBeGreaterThan(
      calculateScore('anthropic/claude-3-sonnet')
    );
  });

  test('score is non-negative for all models', () => {
    for (const model of [
      'anthropic/claude-3-sonnet',
      'anthropic/claude-4-sonnet',
      'mistral/devstral-medium-2507',
      'mistral/codestral-latest',
    ]) {
      const score = calculateScore(model);
      expect(score).toBeGreaterThanOrEqual(0);
    }
  });

  test('unknown model defaults to gdpval 50 → score 50', () => {
    expect(calculateScore('unknown/model')).toBeCloseTo(50.0);
  });

  // Regression: scraped gdpval_scores in the scan cache now routinely exceed
  // 1000 (e.g. claude-sonnet-5=1603, glm-5-2=1497, minimax-m3=1380). A
  // previous Math.min(100, gdpval / 10) cap made every elite model tie at
  // exactly 100 once gdpval crossed 1000, collapsing the 'best' sort to
  // insertion order among them — in production this let a free
  // openrouter/minimax-m2.7:free (gdpval 1157) outrank the far stronger
  // pi-claude/claude-sonnet-5 (gdpval 1603) whenever both happened to be tied
  // at the cap.
  test('does not saturate/cap for gdpval scores above 1000 (regression)', () => {
    setConfig({
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: {
        'claude-sonnet-5': 1603,
        'minimax-m2-7': 1157,
      },
    });
    setGdpval({
      'claude-sonnet-5': 1603,
      'minimax-m2-7': 1157,
    });
    const strong = calculateScore('pi-claude/claude-sonnet-5');
    const weak = calculateScore('openrouter/minimax-m2-7');
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeCloseTo(1603);
    expect(weak).toBeCloseTo(1157);
  });
});
