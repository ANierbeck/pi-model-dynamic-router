// Tests for the pure classifier helpers in content-classifier.ts:
//
//   - CATEGORY_TO_GROUP / getGroupForCategory  (category → router group)
//   - detectHintDirectly                       (deterministic HINT parsing)
//   - classifyStatically                       (keyword-based last resort)
//
// No mocks needed — all three are pure functions.

import { describe, it, expect } from 'vitest';
import {
  CATEGORY_TO_GROUP,
  getGroupForCategory,
  detectHintDirectly,
  classifyStatically,
} from '../src/content-classifier.ts';

describe('CATEGORY_TO_GROUP / getGroupForCategory', () => {
  it('maps all nine categories to their router groups', () => {
    expect(CATEGORY_TO_GROUP).toEqual({
      trivial: 'scout',
      simple: 'operational',
      code_simple: 'simple',
      standard: 'operational',
      code_complex: 'tactical',
      design: 'tactical',
      planning: 'tactical',
      exploration: 'scout',
      fallback: 'tactical',
    });
  });

  it('resolves every known category', () => {
    expect(getGroupForCategory('trivial')).toBe('scout');
    expect(getGroupForCategory('simple')).toBe('operational');
    expect(getGroupForCategory('code_simple')).toBe('simple');
    expect(getGroupForCategory('standard')).toBe('operational');
    expect(getGroupForCategory('code_complex')).toBe('tactical');
    expect(getGroupForCategory('design')).toBe('tactical');
    expect(getGroupForCategory('planning')).toBe('tactical');
    expect(getGroupForCategory('exploration')).toBe('scout');
    expect(getGroupForCategory('fallback')).toBe('tactical');
  });

  it('routes unknown categories to the fallback group', () => {
    expect(getGroupForCategory('does-not-exist')).toBe('fallback');
    expect(getGroupForCategory('')).toBe('fallback');
  });
});

describe('detectHintDirectly', () => {
  it('recognizes an English model hint', () => {
    const hint = detectHintDirectly('HINT: use mistral-medium-3.5');
    expect(hint).toEqual({
      reason: 'User specified model via HINT',
      confidence: 1.0,
      hintType: 'model',
      hintTarget: 'mistral-medium-3.5',
    });
  });

  it('recognizes an English group hint', () => {
    const hint = detectHintDirectly('HINT: use group tactical');
    expect(hint).toEqual({
      reason: 'User specified group via HINT',
      confidence: 1.0,
      hintType: 'group',
      hintTarget: 'tactical',
    });
  });

  it('recognizes a German model hint without a colon', () => {
    const hint = detectHintDirectly('HINT nutze gemma4:12b-mlx bitte weiter');
    expect(hint).not.toBeNull();
    expect(hint!.hintType).toBe('model');
    expect(hint!.hintTarget).toBe('gemma4:12b-mlx');
  });

  it('recognizes a German group hint', () => {
    const hint = detectHintDirectly('HINT: verwende Gruppe Tactical');
    expect(hint).toEqual({
      reason: 'User specified group via HINT',
      confidence: 1.0,
      hintType: 'group',
      hintTarget: 'tactical',
    });
  });

  it('treats MHINT / Model-HINT markers as model-only hints', () => {
    const mhint = detectHintDirectly('MHINT: mistral-medium-3.5');
    expect(mhint).not.toBeNull();
    expect(mhint!.hintType).toBe('model');
    expect(mhint!.hintTarget).toBe('mistral-medium-3.5');

    const modelHint = detectHintDirectly('Model-HINT: mistral-medium-3.5');
    expect(modelHint).not.toBeNull();
    expect(modelHint!.hintType).toBe('model');

    // MHINT with a group verb falls through to the LLM classifier (null):
    // the marker is model-only by definition, and the incomplete-hint guard
    // deliberately routes the contradictory "use group X" form away from
    // literal model-name extraction (it would otherwise target "use").
    expect(detectHintDirectly('MHINT: use group tactical')).toBeNull();
  });

  it('strips trailing punctuation from model targets', () => {
    const hint = detectHintDirectly('HINT: use mistral-medium-3.5,');
    expect(hint).not.toBeNull();
    expect(hint!.hintTarget).toBe('mistral-medium-3.5');
  });

  it('returns null for prose containing the word hint', () => {
    expect(detectHintDirectly('Can I get a hint about this configuration?')).toBeNull();
  });

  it('returns null for incomplete group hints (verb but no name)', () => {
    // Falls through to the LLM classifier instead of misclassifying.
    expect(detectHintDirectly('HINT: use group')).toBeNull();
  });

  it('returns null when no HINT prefix is present', () => {
    expect(detectHintDirectly('Please fix the failing test in routing')).toBeNull();
    expect(detectHintDirectly('')).toBeNull();
  });
});

describe('classifyStatically', () => {
  it('classifies "what is in this file" requests as trivial', () => {
    const result = classifyStatically('what is in this file?');
    expect(result.category).toBe('trivial');
    expect(result.reason).toContain('trivial');
  });

  it('classifies explain/summarize requests as simple', () => {
    const result = classifyStatically('please explain this briefly');
    expect(result.category).toBe('simple');
    expect(result.reason).toContain('Simple question');
  });

  it('classifies small code changes as code_simple', () => {
    const result = classifyStatically('fix the typo in the import line of that code file');
    expect(result.category).toBe('code_simple');
  });

  it('classifies refactoring requests as code_complex', () => {
    const result = classifyStatically('refactor the whole parser for edge cases');
    expect(result.category).toBe('code_complex');
    expect(result.reason).toContain('Complex code task');
  });

  it('classifies roadmap requests as planning', () => {
    const result = classifyStatically('plan the roadmap for next quarter');
    expect(result.category).toBe('planning');
  });

  it('classifies brainstorming requests as exploration', () => {
    const result = classifyStatically('brainstorm some ideas for the launch');
    expect(result.category).toBe('exploration');
  });

  it('falls back to the fallback category for unmatched prompts', () => {
    const result = classifyStatically('xqzwk unrelated gibberish');
    expect(result.category).toBe('fallback');
    expect(result.reason).toContain('Could not classify');
  });
});
