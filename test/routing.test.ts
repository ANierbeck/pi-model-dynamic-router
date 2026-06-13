import { describe, test, expect, beforeAll } from 'vitest';
import { lookupGdp, setConfig } from '../src/metrics.js';

describe('lookupGdp built-in tests', () => {
  beforeAll(() => {
    setConfig({
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: {
        "mistral-medium-3-5": 665,
        "magistral-small": 669,
        "magistral-medium": 665,
        "devstral": 585,
        "codestral-latest": 520
      }
    });
  });

  test('lookupGdp returns correct built-in score for mistral-medium-3-5', () => {
    const score = lookupGdp("mistral-medium-3-5");
    expect(score).toBeGreaterThanOrEqual(600);
  });

  test('lookupGdp returns correct built-in score for mistral-medium-3-5 with gdpval_builtin only', () => {
    const score = lookupGdp("mistral-medium-3-5");
    expect(score).toBeGreaterThanOrEqual(600);
    expect(score).toBe(665);
  });

  test('lookupGdp returns correct built-in score for mistral/mistral-medium-3.5', () => {
    const score = lookupGdp("mistral/mistral-medium-3.5");
    expect(score).toBeGreaterThanOrEqual(600);
  });
});
