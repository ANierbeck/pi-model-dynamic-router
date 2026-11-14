/**
 * ADR-0030 Option 1: user corrections of the classifier's category, kept in
 * `cache.hint_corrections` (the existing cache.json; ADR 0002 Option B).
 *
 * A correction is written only from an explicit `HINT: category <name>`
 * prompt and is matched only by the exact prompt text that follows the
 * HINT head. The rules that keep it from misrouting silently:
 *  - exact key: trimmed at both ends, no case folding, no whitespace
 *    collapsing (code and literals differ in exactly those details);
 *  - prompts under MIN_CORRECTION_WORDS words are never stored or matched
 *    (`continue`, `ok` and the like mean different things per turn);
 *  - one entry per key, last write wins;
 *  - an entry whose category is no longer in the taxonomy is reported as
 *    stale and never applied;
 *  - the store is capped at MAX_HINT_CORRECTIONS entries; the least recently
 *    used entry goes first.
 *
 * Pure functions over the store object. The store is a plain object whose
 * insertion order is the recency order, so a hit re-inserts its entry.
 */
import { VALID_CATEGORIES } from './classification-prompt.ts';

/** Same cap as the classification cache in content-classifier.ts. */
export const MAX_HINT_CORRECTIONS = 64;

/** Prompts under this many words are never stored or matched (ADR-0030). */
export const MIN_CORRECTION_WORDS = 5;

export type CorrectionCategory = (typeof VALID_CATEGORIES)[number];

export interface HintCorrection {
  hintType: 'category';
  /** The category the user named. */
  target: string;
  savedAt: string;
}

export type HintCorrections = Record<string, HintCorrection>;

export interface CorrectionListing {
  key: string;
  category: string;
  savedAt: string;
}

/** A category hit, a stale hit (name no longer in the taxonomy), or a miss. */
export type CorrectionLookup = { category: CorrectionCategory } | { stale: string } | null;

export function isCorrectionCategory(name: string): name is CorrectionCategory {
  return (VALID_CATEGORIES as readonly string[]).includes(name);
}

/**
 * The exact store key for a prompt: trimmed, otherwise untouched. Null when
 * the prompt is too short to be stored or matched.
 */
export function correctionKey(content: string): string | null {
  const key = content.trim();
  const words = key.split(/\s+/).filter((w) => w.length > 0).length;
  return words >= MIN_CORRECTION_WORDS ? key : null;
}

/**
 * Saves (or replaces) the correction for `content`. Returns false, and leaves
 * the store untouched, when the content is too short to be stored.
 */
export function recordCorrection(
  store: HintCorrections,
  content: string,
  category: CorrectionCategory,
  savedAt: string
): boolean {
  const key = correctionKey(content);
  if (key === null) return false;
  delete store[key];
  store[key] = { hintType: 'category', target: category, savedAt };
  const keys = Object.keys(store);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_HINT_CORRECTIONS))) {
    delete store[old];
  }
  return true;
}

/**
 * Looks up the correction for `content`. A hit moves the entry to the
 * most-recently-used end of the store.
 */
export function lookupCorrection(store: HintCorrections, content: string): CorrectionLookup {
  const key = correctionKey(content);
  if (key === null || !Object.prototype.hasOwnProperty.call(store, key)) return null;
  const entry = store[key];
  delete store[key];
  store[key] = entry;
  if (!isCorrectionCategory(entry.target)) return { stale: entry.target };
  return { category: entry.target };
}

/** The stored corrections, most recently used first (for `/router corrections list`). */
export function listCorrections(store: HintCorrections): CorrectionListing[] {
  return Object.keys(store)
    .reverse()
    .map((key) => ({
      key,
      category: store[key].target,
      savedAt: store[key].savedAt,
    }));
}

/** Drops every correction and returns how many there were. */
export function clearCorrections(store: HintCorrections): number {
  const keys = Object.keys(store);
  for (const key of keys) delete store[key];
  return keys.length;
}

/** The rejection of an unknown category name in a HINT (ADR-0030). */
export function unknownCategoryMessage(name: string): string {
  return `[classifier] HINT names an unknown category "${name}"; ignored. Valid: ${VALID_CATEGORIES.join(', ')}`;
}

/** A saved correction whose category is no longer in the taxonomy. */
export function staleCorrectionMessage(name: string): string {
  return `[classifier] saved HINT correction names "${name}", which is no longer a category; classifying normally`;
}
