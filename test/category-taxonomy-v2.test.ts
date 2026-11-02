// test/category-taxonomy-v2.test.ts
// Production migration of the validated 7-category taxonomy (v2-r3,
// docs/plans/2026-10-11-category-model-alignment.md, Phase 2 freeze 2026-10-13):
//   - trivial and exploration are DROPPED (GLM never used them correctly,
//     the owner never used them in 180 ratings),
//   - fallback is RENAMED to continue (73 % of the fallback items were true
//     continuations in the owner continue-pass),
//   - continue goes to the standard mid band (D6).
// Red-first: these pins were observed failing against the pre-migration code.

import { describe, it, expect } from 'vitest';
import {
  VALID_CATEGORIES,
  CLASSIFICATION_PROMPT,
} from '../src/classification-prompt.ts';
import {
  CATEGORY_TO_GROUP,
  classifyStatically,
} from '../src/content-classifier.ts';

const SEVEN = ['simple', 'code_simple', 'standard', 'code_complex', 'design', 'planning', 'continue'];

describe('v2 taxonomy: category set', () => {
  it('VALID_CATEGORIES is exactly the seven v2 categories', () => {
    expect([...VALID_CATEGORIES].sort()).toEqual([...SEVEN].sort());
  });

  it('CATEGORY_TO_GROUP has a group for exactly the seven v2 categories', () => {
    expect(Object.keys(CATEGORY_TO_GROUP).sort()).toEqual([...SEVEN].sort());
  });
});

describe('v2 taxonomy: category → group mapping', () => {
  it('continue routes to standard (D6: a decent model, not a free one)', () => {
    expect(CATEGORY_TO_GROUP.continue).toBe('standard');
  });

  it('simple routes to the merged cheap pool named like the category (D4/D7)', () => {
    expect(CATEGORY_TO_GROUP.simple).toBe('simple');
  });

  it('keeps the unchanged mappings for the other five categories', () => {
    expect(CATEGORY_TO_GROUP.code_simple).toBe('simple');
    expect(CATEGORY_TO_GROUP.standard).toBe('standard');
    expect(CATEGORY_TO_GROUP.code_complex).toBe('code_complex');
    expect(CATEGORY_TO_GROUP.design).toBe('design');
    expect(CATEGORY_TO_GROUP.planning).toBe('planning');
  });
});

describe('v2 taxonomy: static keyword classifier', () => {
  it('a "what is in this file" lookup is simple (was trivial)', () => {
    expect(classifyStatically("what's in this file?").category).toBe('simple');
  });

  it('open-ended brainstorming is standard (was exploration)', () => {
    expect(classifyStatically('brainstorm some ideas for the router').category).toBe('standard');
  });

  it('an unclassifiable prompt is continue (was fallback)', () => {
    expect(classifyStatically('zzz qqq').category).toBe('continue');
  });
});

describe('v2 taxonomy: production prompt is the validated v2-r3 prompt', () => {
  it('carries the decision procedure (Step 1 new act / Step 2 continue)', () => {
    expect(CLASSIFICATION_PROMPT).toContain('Step 1 - Does the request open a NEW act');
    expect(CLASSIFICATION_PROMPT).toContain('Step 2 - If instead the request only keeps the CURRENT act moving');
  });

  it('defines the continue category and the mechanical-execution clause', () => {
    expect(CLASSIFICATION_PROMPT).toContain('continue:     NOT a self-contained task');
    expect(CLASSIFICATION_PROMPT).toContain('mechanically EXECUTE or conclude the current act');
  });

  it('no longer offers the dropped categories', () => {
    expect(CLASSIFICATION_PROMPT).not.toMatch(/\btrivial:/);
    expect(CLASSIFICATION_PROMPT).not.toMatch(/\bexploration:/);
    expect(CLASSIFICATION_PROMPT).not.toMatch(/\bfallback:/);
  });

  it('keeps the context and request placeholders the builder fills', () => {
    expect(CLASSIFICATION_PROMPT).toContain('{{context_block}}');
    expect(CLASSIFICATION_PROMPT).toContain('{{prompt}}');
  });
});
