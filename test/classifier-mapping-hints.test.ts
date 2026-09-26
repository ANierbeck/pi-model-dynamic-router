// Tests for CATEGORY_TO_GROUP / getGroupForCategory (category → router group).
// detectHintDirectly lives in hint-classification / detect-hint-synonyms,
// classifyStatically in classifier.test.ts.

import { describe, it, expect } from 'vitest';
import { CATEGORY_TO_GROUP, getGroupForCategory } from '../src/content-classifier.ts';

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
