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
  capCorrections,
} from '../src/hint-corrections.ts';
import { CacheManager } from '../src/cache.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

describe('stale and malformed entries', () => {
  it('a stale hit is dropped once it has been reported', () => {
    const store = { [PROMPT]: { hintType: 'category', target: 'roadmap', savedAt: 'x' } };
    expect(lookupCorrection(store, PROMPT)).toEqual({ stale: 'roadmap' });
    expect(store).toEqual({});
  });

  it('an entry without a string target is treated as absent and does not break the listing', () => {
    const store: any = {
      'a prompt with five words here': null,
      [PROMPT]: { hintType: 'category', target: 'planning', savedAt: 'x' },
    };
    expect(lookupCorrection(store, 'a prompt with five words here')).toBeNull();
    expect(listCorrections(store).map((e) => e.key)).toEqual([PROMPT]);
  });
});

describe('capCorrections (after a merge from another process)', () => {
  const key = (i: number): string => `merged prompt number ${i} with five words`;
  const at = (i: number): string => new Date(Date.UTC(2026, 10, 14, 0, 0, i)).toISOString();

  it('keeps the newest MAX_HINT_CORRECTIONS entries by savedAt and reports how many it dropped', () => {
    // Written directly: recordCorrection already keeps the store within the cap.
    const store: any = {};
    for (let i = 0; i < MAX_HINT_CORRECTIONS + 3; i++) {
      store[key(i)] = { hintType: 'category', target: 'simple', savedAt: at(i) };
    }
    expect(capCorrections(store)).toBe(3);
    expect(Object.keys(store)).toHaveLength(MAX_HINT_CORRECTIONS);
    expect(store[key(0)]).toBeUndefined();
    expect(store[key(MAX_HINT_CORRECTIONS + 2)]).toBeDefined();
  });

  it('saveCache keeps the cap when the file on disk has entries this process does not know', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hint-cap-'));
    try {
      const other: any = {};
      for (let i = 0; i < MAX_HINT_CORRECTIONS; i++) {
        recordCorrection((other.hint_corrections ??= {}), key(i), 'simple', at(i));
      }
      new CacheManager(dir, other).saveCache();

      const mine: any = {};
      for (let i = 0; i < MAX_HINT_CORRECTIONS; i++) {
        recordCorrection(
          (mine.hint_corrections ??= {}),
          key(MAX_HINT_CORRECTIONS + i),
          'design',
          at(MAX_HINT_CORRECTIONS + i)
        );
      }
      new CacheManager(dir, mine).saveCache();

      const onDisk = JSON.parse(readFileSync(path.join(dir, '.cache', 'scan-cache.json'), 'utf8'));
      const kept = Object.keys(onDisk.hint_corrections);
      expect(kept.length).toBeLessThanOrEqual(MAX_HINT_CORRECTIONS);
      expect(kept).toContain(key(MAX_HINT_CORRECTIONS + MAX_HINT_CORRECTIONS - 1));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('corrections survive a restart (CacheManager round-trip on the same dir)', () => {
  const dir = (): string => mkdtempSync(path.join(tmpdir(), 'hint-roundtrip-'));
  const key = (i: number): string => `round trip prompt number ${i} with five words`;
  const at = (i: number): string => new Date(Date.UTC(2026, 10, 14, 0, 0, i)).toISOString();

  it('a fresh CacheManager with an empty cache object adopts a persisted correction on loadCache', () => {
    const d = dir();
    try {
      const first = new CacheManager(d);
      const c1 = first.getCache() as any;
      c1.hint_corrections = {};
      recordCorrection(c1.hint_corrections, PROMPT, 'planning', '2026-11-14T10:00:00.000Z');
      first.saveCache();

      // Fresh manager on the same dir, empty in-memory cache object.
      const existing: any = {};
      new CacheManager(d, existing).loadCache();
      expect(lookupCorrection(existing.hint_corrections ?? {}, PROMPT)).toEqual({
        category: 'planning',
      });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('a hand-corrupted hint_corrections value on disk is dropped on load instead of breaking the store', () => {
    // A non-object value (string, null, array) used to be adopted as-is; the
    // next recordCorrection then wrote a property onto a primitive and threw.
    for (const corrupt of ['garbage', null, ['a', 'b']]) {
      const d = dir();
      try {
        mkdirSync(path.join(d, '.cache'), { recursive: true });
        writeFileSync(
          path.join(d, '.cache', 'scan-cache.json'),
          JSON.stringify({ lastScanTimestamp: 1, hint_corrections: corrupt })
        );
        const mine: any = {};
        new CacheManager(d, mine).loadCache();
        expect(mine.hint_corrections).toBeUndefined();
        expect(() =>
          recordCorrection(mine.hint_corrections ?? {}, PROMPT, 'planning', at(0))
        ).not.toThrow();
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it("mergeExternal adopts another process's corrections and re-caps them at MAX_HINT_CORRECTIONS", () => {
    const d = dir();
    try {
      // Another process wrote MORE than the cap straight to the file.
      const other: any = { lastScanTimestamp: 1, hint_corrections: {} };
      for (let i = 0; i < MAX_HINT_CORRECTIONS + 3; i++) {
        other.hint_corrections[key(i)] = { hintType: 'category', target: 'simple', savedAt: at(i) };
      }
      new CacheManager(d, other).saveCache();

      // A fresh manager whose memory is NOT empty takes the mergeExternal path.
      const mine: any = { lastScanTimestamp: 2 };
      new CacheManager(d, mine).loadCache();
      const store = mine.hint_corrections ?? {};
      expect(Object.keys(store)).toHaveLength(MAX_HINT_CORRECTIONS);
      // The newest entries survive the re-cap, the oldest are dropped.
      expect(lookupCorrection(store, key(MAX_HINT_CORRECTIONS + 2))).toEqual({
        category: 'simple',
      });
      expect(lookupCorrection(store, key(0))).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('the cache file is written owner-only (mode 0600): its correction keys are raw prompt texts', () => {
    const d = dir();
    try {
      const m = new CacheManager(d);
      const c = m.getCache() as any;
      c.hint_corrections = {};
      recordCorrection(c.hint_corrections, PROMPT, 'planning', '2026-11-14T10:00:00.000Z');
      m.saveCache();
      const mode = statSync(path.join(d, '.cache', 'scan-cache.json')).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
