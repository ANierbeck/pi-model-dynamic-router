/**
 * Tests for -latest aliases and dated snapshots (design:
 * docs/plans/2026-09-20-latest-alias-slug-matching-design.md).
 *
 * Mistral's catalog exposes rolling aliases (mistral-medium-latest) and
 * dated snapshots (mistral-medium-2604, user-observed mistral-medium-0426).
 * Before this fix the GDPval slug matcher handled both incorrectly:
 *
 * 1. -latest refs match "any version" (Rule 2 skips the version check when
 *    the ref has no version numbers), but the tie-break among equal-score
 *    slugs was "first iterated" — mistral-small-latest matched
 *    mistral-small-3-1 (421) instead of the newest mistral-small-3-2 (478),
 *    purely by object iteration order.
 * 2. Dated snapshots went into the major-version check: mistral-medium-2604
 *    compared major 2604 vs slug major 3 → no match at all → GDPval null →
 *    dropped from every quality group, no dedup identity.
 *
 * Fix: a trailing exactly-4-digit number token (YYMM/MMDD) is a date
 * marker, not a semantic version — it is excluded from the version check
 * (version-less matching, like -latest). Among equal-score candidates the
 * slug with the HIGHEST version tuple wins (newest version).
 */
import { describe, it, expect } from 'vitest';
import { matchSlug, candidateSlugs } from '../src/slug-matcher.ts';

// Slugs the real GDPval scrape + gdpval_builtin contain for these families.
const MISTRAL_FAMILY_SLUGS = [
  'mistral-medium-3-5',
  'mistral-small-3-1',
  'mistral-small-3-2',
  'mistral-nemo',
  'magistral-medium',
  'magistral-small',
  'devstral',
  'codestral-latest',
];
const ZAI_SLUGS = ['zai-glm-5-2', 'zai-glm-5-3'];
const GLM_SLUGS = ['glm-4', 'glm-4-6'];

describe('matchSlug: -latest resolves to the NEWEST version of the family', () => {
  it('multi-version family picks the newest (mistral-small-latest → mistral-small-3-2)', () => {
    expect(matchSlug('mistral/mistral-small-latest', MISTRAL_FAMILY_SLUGS)).toBe('mistral-small-3-2');
  });

  it('single-version family still matches (mistral-medium-latest → mistral-medium-3-5)', () => {
    expect(matchSlug('mistral/mistral-medium-latest', MISTRAL_FAMILY_SLUGS)).toBe('mistral-medium-3-5');
  });

  it('zai-glm-latest → zai-glm-5-3 regardless of slug iteration order', () => {
    expect(matchSlug('mistral/zai-glm-latest', ZAI_SLUGS)).toBe('zai-glm-5-3');
    expect(matchSlug('mistral/zai-glm-latest', [...ZAI_SLUGS].reverse())).toBe('zai-glm-5-3');
  });

  it('suffix token order in the slug list must not change the result', () => {
    // Same list, different order — the newest version must still win.
    const shuffled = [...MISTRAL_FAMILY_SLUGS].reverse();
    expect(matchSlug('mistral/mistral-small-latest', shuffled)).toBe('mistral-small-3-2');
  });
});

describe('matchSlug: dated snapshots resolve as version-less aliases', () => {
  it('YYMM form: mistral-medium-2604 → mistral-medium-3-5', () => {
    expect(matchSlug('mistral/mistral-medium-2604', MISTRAL_FAMILY_SLUGS)).toBe('mistral-medium-3-5');
  });

  it('MMDD form: mistral-medium-0426 → mistral-medium-3-5', () => {
    expect(matchSlug('mistral/mistral-medium-0426', MISTRAL_FAMILY_SLUGS)).toBe('mistral-medium-3-5');
  });

  it('dated snapshot in a multi-version family picks the newest (mistral-small-2603 → 3-2)', () => {
    expect(matchSlug('mistral/mistral-small-2603', MISTRAL_FAMILY_SLUGS)).toBe('mistral-small-3-2');
  });

  it('MMDD form with leading zero (deepseek-r1-0528) is date-like, not a version', () => {
    expect(matchSlug('deepseek/deepseek-r1-0528', ['deepseek-r1'])).toBe('deepseek-r1');
  });

  it('unversioned family slugs still match dated snapshots (devstral-small-2505 → devstral)', () => {
    expect(matchSlug('mistral/devstral-small-2505', MISTRAL_FAMILY_SLUGS)).toBe('devstral');
  });
});

describe('matchSlug: newest-version tie-break also fixes versioned refs', () => {
  it('glm-4.6 prefers glm-4-6 over glm-4 (both pass the major check)', () => {
    expect(matchSlug('openrouter/z-ai/glm-4.6', GLM_SLUGS)).toBe('glm-4-6');
  });

  it('same-major multi-version zai ref prefers the newest', () => {
    expect(matchSlug('mistral/zai-glm-5', ZAI_SLUGS)).toBe('zai-glm-5-3');
  });
});

describe('matchSlug: regressions — exact and major-checked matches unchanged', () => {
  it('exact normalized match still wins over fuzzy (mistral-small-3-1)', () => {
    expect(matchSlug('mistral/mistral-small-3-1', MISTRAL_FAMILY_SLUGS)).toBe('mistral-small-3-1');
  });

  it('8-digit full dates are NOT date-marked (claude-3-5-sonnet-20241022 keeps its major check)', () => {
    expect(matchSlug('anthropic/claude-3-5-sonnet-20241022', ['claude-3-5-sonnet'])).toBe(
      'claude-3-5-sonnet'
    );
  });

  it('parameter counts are not date-marked (gemma3-12b keeps version semantics)', () => {
    expect(matchSlug('ollama/gemma3-12b', ['gemma3-12b', 'gemma3-27b'])).toBe('gemma3-12b');
  });

  it('codestral-latest exact slug still wins (Stage 3 before exclusion)', () => {
    expect(matchSlug('mistral/codestral-latest', MISTRAL_FAMILY_SLUGS)).toBe('codestral-latest');
  });
});

describe('candidateSlugs: newest version first for version-less refs', () => {
  it('orders mistral-small-3-2 before mistral-small-3-1 for -latest', () => {
    const candidates = candidateSlugs('mistral/mistral-small-latest', MISTRAL_FAMILY_SLUGS, 3);
    expect(candidates[0]).toBe('mistral-small-3-2');
  });

  it('includes the newest version for dated snapshots', () => {
    const candidates = candidateSlugs('mistral/mistral-medium-2604', MISTRAL_FAMILY_SLUGS, 3);
    expect(candidates[0]).toBe('mistral-medium-3-5');
  });
});
