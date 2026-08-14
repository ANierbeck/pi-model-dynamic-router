// test/dedup-models.test.ts
// Tests for deduplication of models that refer to the same underlying model.
// e.g. mistral-medium-2604, mistral-medium-latest, and mistral-medium-3-5
// are all the same model — only one should appear in each group.

import { describe, it, expect } from 'vitest';

// Test the dedup logic directly (extracted from routing.ts)
// The key insight: models that match the same GDPval slug + same provider
// are duplicates (different versions of the same model from the same provider).

function dedupByModelIdentity(
  refs: string[],
  getMatchedSlug: (ref: string) => string | null
): string[] {
  const seen = new Map<string, string>(); // provider:slug → best ref
  const result: string[] = [];

  // Variant preference: versioned > explicit version > -latest
  const variantScore = (modelId: string): number => {
    if (/-(latest|preview)$/i.test(modelId)) return 1;
    if (/-(?:\d{4}|\d{6}|\d{8})$/i.test(modelId)) return 3;
    if (/[-.]\d/i.test(modelId)) return 2;
    return 0;
  };

  for (const ref of refs) {
    const slug = getMatchedSlug(ref);
    if (slug) {
      const provider = ref.split('/')[0];
      const key = `${provider}:${slug}`;
      const existing = seen.get(key);
      if (existing) {
        // Keep the better variant (versioned > explicit > -latest)
        const refScore = variantScore(ref.split('/').pop() ?? ref);
        const existingScore = variantScore(existing.split('/').pop() ?? existing);
        if (refScore > existingScore) {
          const idx = result.indexOf(existing);
          if (idx !== -1) result[idx] = ref;
          seen.set(key, ref);
        }
        continue;
      }
      seen.set(key, ref);
    }
    result.push(ref);
  }
  return result;
}

describe('dedupByModelIdentity', () => {
  // Simulated slug matcher: maps model refs to their GDPval slug
  const mockGetMatchedSlug = (ref: string): string | null => {
    const map: Record<string, string> = {
      'mistral/mistral-medium-2604': 'mistral-medium-3-5',
      'mistral/mistral-medium-latest': 'mistral-medium-3-5',
      'mistral/mistral-medium-3-5': 'mistral-medium-3-5',
      'mistral/devstral-2512': 'devstral',
      'mistral/devstral-latest': 'devstral',
      'mistral-zai/zai-glm-5-2': 'glm-5-2',
      'mistral/glm-5-2': 'glm-5-2',
    };
    return map[ref] ?? null;
  };

  it('removes duplicate versions from the same provider', () => {
    const refs = [
      'mistral/mistral-medium-2604',
      'mistral/mistral-medium-latest',
      'mistral/mistral-medium-3-5',
    ];
    const result = dedupByModelIdentity(refs, mockGetMatchedSlug);
    // All three match the same slug from the same provider → keep only first
    expect(result).toEqual(['mistral/mistral-medium-2604']);
  });

  it('keeps different providers offering the same model', () => {
    const refs = [
      'mistral-zai/zai-glm-5-2',
      'mistral/glm-5-2',
    ];
    const result = dedupByModelIdentity(refs, mockGetMatchedSlug);
    // Same slug (glm-5-2) but different providers → keep both (for failover)
    expect(result).toEqual(['mistral-zai/zai-glm-5-2', 'mistral/glm-5-2']);
  });

  it('keeps models with different slugs', () => {
    const refs = [
      'mistral/mistral-medium-2604',
      'mistral/devstral-2512',
    ];
    const result = dedupByModelIdentity(refs, mockGetMatchedSlug);
    expect(result).toEqual(refs);
  });

  it('keeps models with no slug match (unmatched models)', () => {
    const refs = [
      'mistral/mistral-medium-2604',
      'unknown-provider/unknown-model',
    ];
    const result = dedupByModelIdentity(refs, mockGetMatchedSlug);
    expect(result).toEqual(refs);
  });

  it('deduplicates devstral-2512 and devstral-latest', () => {
    const refs = [
      'mistral/devstral-2512',
      'mistral/devstral-latest',
    ];
    const result = dedupByModelIdentity(refs, mockGetMatchedSlug);
    expect(result).toEqual(['mistral/devstral-2512']);
  });

  it('handles empty input', () => {
    expect(dedupByModelIdentity([], mockGetMatchedSlug)).toEqual([]);
  });

  it('prefers versioned model over -latest (reproducibility)', () => {
    // Simulate the full dedup with variant preference
    // mistral-medium-2604 (versioned, score 3) should win over
    // mistral-medium-latest (alias, score 1)
    const refs = [
      'mistral/mistral-medium-latest',   // score 1
      'mistral/mistral-medium-2604',     // score 3
    ];
    const result = dedupByModelIdentity(refs, mockGetMatchedSlug);
    // Should keep the versioned one (2604), not -latest
    expect(result).toEqual(['mistral/mistral-medium-2604']);
  });

  it('prefers versioned model even if -latest comes first', () => {
    const refs = [
      'mistral/mistral-medium-2604',     // score 3, comes first
      'mistral/mistral-medium-latest',   // score 1, comes second
    ];
    const result = dedupByModelIdentity(refs, mockGetMatchedSlug);
    expect(result).toEqual(['mistral/mistral-medium-2604']);
  });

  it('prefers explicit version name over -latest', () => {
    // Simulate: mistral-medium-3.5 (explicit, score 2) vs -latest (score 1)
    const mockGetMatchedSlug2 = (ref: string): string | null => {
      const map: Record<string, string> = {
        'mistral/mistral-medium-latest': 'mistral-medium-3-5',
        'mistral/mistral-medium-3.5': 'mistral-medium-3-5',
      };
      return map[ref] ?? null;
    };
    const refs = [
      'mistral/mistral-medium-latest',   // score 1
      'mistral/mistral-medium-3.5',      // score 2
    ];
    const result = dedupByModelIdentity(refs, mockGetMatchedSlug2);
    expect(result).toEqual(['mistral/mistral-medium-3.5']);
  });
});