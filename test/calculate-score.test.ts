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

  test('returns GDPval / 10, clamped to 100', () => {
    expect(calculateScore('anthropic/claude-4-sonnet')).toBeCloseTo(72.0);
    expect(calculateScore('anthropic/claude-3-sonnet')).toBeCloseTo(68.0);
    expect(calculateScore('mistral/devstral-medium-2507')).toBeCloseTo(69.1);
    expect(calculateScore('mistral/codestral-latest')).toBeCloseTo(52.0);
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

  test('score is between 0 and 100 for all models', () => {
    for (const model of [
      'anthropic/claude-3-sonnet',
      'anthropic/claude-4-sonnet',
      'mistral/devstral-medium-2507',
      'mistral/codestral-latest',
    ]) {
      const score = calculateScore(model);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  test('unknown model defaults to gdpval 50 → score 5', () => {
    expect(calculateScore('unknown/model')).toBeCloseTo(5.0);
  });
});
