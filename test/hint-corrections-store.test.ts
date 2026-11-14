/**
 * ADR-0030 Option 1: the correction store in cache.hint_corrections.
 * Exact-match key (trimmed, no case folding), last write wins, LRU cap,
 * short prompts never stored, stale category names reported, not applied.
 */
import { describe, it, expect } from 'vitest';
import {
  correctionKey,
  recordCorrection,
  lookupCorrection,
  listCorrections,
  clearCorrections,
  MAX_HINT_CORRECTIONS,
  unknownCategoryMessage,
  staleCorrectionMessage,
} from '../src/hint-corrections.ts';
import { VALID_CATEGORIES } from '../src/classification-prompt.ts';

const PROMPT = 'Design a rollout plan for the new cache layer';

describe('correctionKey (exact-match rule)', () => {
  it('trims both ends and keeps case and inner spacing', () => {
    expect(correctionKey('  Fix   the Bug in parse.ts now  ')).toBe(
      'Fix   the Bug in parse.ts now'
    );
  });

  it('returns null under five words: short prompts are never stored or matched', () => {
    expect(correctionKey('keep going please')).toBeNull();
    expect(correctionKey('continue')).toBeNull();
  });

  it('accepts exactly five words', () => {
    expect(correctionKey('one two three four five')).toBe('one two three four five');
  });

  it('returns null for an empty or whitespace-only prompt', () => {
    expect(correctionKey('')).toBeNull();
    expect(correctionKey('   \n  ')).toBeNull();
  });
});

describe('recordCorrection / lookupCorrection', () => {
  it('a stored category is found by its exact key', () => {
    const store = {};
    recordCorrection(store, PROMPT, 'planning', '2026-11-14T10:00:00.000Z');
    expect(lookupCorrection(store, PROMPT)).toEqual({
      category: 'planning',
    });
  });

  it('a different case or spacing is a miss (no folding)', () => {
    const store = {};
    recordCorrection(store, PROMPT, 'planning', '2026-11-14T10:00:00.000Z');
    expect(lookupCorrection(store, PROMPT.toUpperCase())).toBeNull();
    expect(lookupCorrection(store, PROMPT.replace(' a ', '  a  '))).toBeNull();
  });

  it('last write wins for the same key and records the new time', () => {
    const store = {};
    recordCorrection(store, PROMPT, 'planning', '2026-11-14T10:00:00.000Z');
    recordCorrection(store, PROMPT, 'design', '2026-11-14T11:00:00.000Z');
    expect(lookupCorrection(store, PROMPT)).toEqual({ category: 'design' });
    expect(listCorrections(store)).toEqual([
      { key: PROMPT, category: 'design', savedAt: '2026-11-14T11:00:00.000Z' },
    ]);
  });

  it('a stored name that is no longer a category is reported stale, not applied', () => {
    const store = { [PROMPT]: { hintType: 'category', target: 'roadmap', savedAt: 'x' } };
    expect(lookupCorrection(store, PROMPT)).toEqual({
      stale: 'roadmap',
    });
  });

  it('a prototype name is a plain miss, not an inherited property', () => {
    expect(lookupCorrection({}, 'toString')).toBeNull();
  });

  it('the store is capped: the least recently used entry is dropped', () => {
    const store = {};
    const key = (i: number): string => `prompt number ${i} with five words`;
    for (let i = 0; i < MAX_HINT_CORRECTIONS; i++) {
      recordCorrection(store, key(i), 'simple', '2026-11-14T10:00:00.000Z');
    }
    // A hit refreshes key(0), so key(1) becomes the least recently used.
    expect(lookupCorrection(store, key(0))).not.toBeNull();
    recordCorrection(store, key(MAX_HINT_CORRECTIONS), 'simple', '2026-11-14T10:00:00.000Z');
    expect(Object.keys(store)).toHaveLength(MAX_HINT_CORRECTIONS);
    expect(lookupCorrection(store, key(1))).toBeNull();
    expect(lookupCorrection(store, key(0))).not.toBeNull();
  });

  it('recording a short prompt is refused and leaves the store untouched', () => {
    const store = {};
    expect(recordCorrection(store, 'keep going', 'simple', 'x')).toBe(false);
    expect(store).toEqual({});
  });
});

describe('listCorrections / clearCorrections', () => {
  it('lists the most recently saved correction first', () => {
    const store = {};
    recordCorrection(store, 'first prompt with five words', 'simple', '2026-11-14T09:00:00.000Z');
    recordCorrection(store, 'second prompt with five words', 'design', '2026-11-14T10:00:00.000Z');
    expect(listCorrections(store).map((e) => e.category)).toEqual(['design', 'simple']);
  });

  it('re-saving a prompt makes it the most recent entry in the list', () => {
    const store = {};
    recordCorrection(store, 'first prompt with five words', 'simple', '2026-11-14T09:00:00.000Z');
    recordCorrection(store, 'second prompt with five words', 'design', '2026-11-14T10:00:00.000Z');
    recordCorrection(store, 'first prompt with five words', 'planning', '2026-11-14T11:00:00.000Z');
    expect(listCorrections(store).map((e) => e.key)).toEqual([
      'first prompt with five words',
      'second prompt with five words',
    ]);
  });

  it('clear empties the store and reports how many entries it dropped', () => {
    const store = {};
    recordCorrection(store, PROMPT, 'planning', 'x');
    expect(clearCorrections(store)).toBe(1);
    expect(store).toEqual({});
    expect(clearCorrections(store)).toBe(0);
  });
});

describe('user-facing messages', () => {
  it('an unknown name is reported with the name typed and every valid category', () => {
    const msg = unknownCategoryMessage('roadmap');
    expect(msg).toContain('"roadmap"');
    for (const c of VALID_CATEGORIES) expect(msg).toContain(c);
  });

  it('a stale correction is reported with the stored name', () => {
    expect(staleCorrectionMessage('roadmap')).toContain('"roadmap"');
  });
});
