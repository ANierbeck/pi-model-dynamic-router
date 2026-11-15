/**
 * ADR-0030 Option 1, syntax: the category form of HINT is recognised by
 * detectCategoryHint and is never read as a model pin. No model is called.
 */
import { describe, it, expect } from 'vitest';
import { detectCategoryHint, detectHintDirectly } from '../src/content-classifier.ts';

const CONTENT = 'Design a rollout plan for the new cache layer';
const HINTED = `HINT: category planning ${CONTENT}`;

describe('detectCategoryHint (syntax)', () => {
  it('reads the category and the content after it', () => {
    expect(detectCategoryHint(HINTED)).toEqual({
      kind: 'category',
      category: 'planning',
      content: CONTENT,
    });
  });

  it('the keyword and the name are case-insensitive; the name is lower-cased', () => {
    expect(detectCategoryHint(`hint: CATEGORY Planning ${CONTENT}`)).toMatchObject({
      kind: 'category',
      category: 'planning',
    });
  });

  it('an unknown name is reported as unknown, with the name it typed', () => {
    expect(detectCategoryHint(`HINT: category roadmap ${CONTENT}`)).toEqual({
      kind: 'unknown',
      name: 'roadmap',
      content: CONTENT,
    });
  });

  it('the colon form only: "HINT category planning" is not a category hint', () => {
    expect(detectCategoryHint(`HINT category planning ${CONTENT}`)).toBeNull();
  });

  it('ordinary HINT forms are not category hints', () => {
    expect(detectCategoryHint('HINT: use mistral-medium-3.5')).toBeNull();
    expect(detectCategoryHint('no hint here at all')).toBeNull();
  });

  it('detectHintDirectly never reads the category form as a model pin named "category"', () => {
    expect(detectHintDirectly(HINTED)).toBeNull();
    expect(detectHintDirectly(`HINT: category roadmap ${CONTENT}`)).toBeNull();
  });
});
