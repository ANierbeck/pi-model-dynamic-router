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

  test('score is not affected by taskType argument', () => {
    const base = calculateScore('mistral/codestral-latest');
    expect(calculateScore('mistral/codestral-latest', 'code')).toBe(base);
    expect(calculateScore('mistral/codestral-latest', 'standard')).toBe(base);
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
