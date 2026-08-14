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
  const seen = new Map<string, string>(); // provider:slug → first ref
  const result: string[] = [];
  for (const ref of refs) {
    const slug = getMatchedSlug(ref);
    if (slug) {
      const provider = ref.split('/')[0];
      const key = `${provider}:${slug}`;
      if (seen.has(key)) continue;
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
});