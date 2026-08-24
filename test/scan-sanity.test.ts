// test/scan-sanity.test.ts
// Tests for the pre-persist sanity check that guards against a "scoring
// collapse" scan getting frozen into router-config.dynamic.json for up to
// 30 days (see src/scan-sanity.ts for the incident this defends against).

import { describe, it, expect } from 'vitest';
import { checkScanSanity } from '../src/scan-sanity.ts';

function refs(n: number, prefix = 'provider/model'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

describe('checkScanSanity — global scoring collapse', () => {
  it('passes a healthy scan (most models scored)', () => {
    const scanned = refs(125);
    const survivors = scanned.slice(0, 62); // ~50% survival, matches real observed ratio
    const result = checkScanSanity({
      scannedRefs: scanned,
      survivorRefs: survivors,
      explicitlyMappedRefs: [],
      explicitlyMappedScoredRefs: [],
    });
    expect(result.ok).toBe(true);
  });

  it('flags the EXACT observed incident: 13/125 scored (10.4%)', () => {
    const scanned = refs(125);
    const survivors = scanned.slice(0, 13);
    const result = checkScanSanity({
      scannedRefs: scanned,
      survivorRefs: survivors,
      explicitlyMappedRefs: [],
      explicitlyMappedScoredRefs: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/scoring collapse/);
    expect(result.survivorCount).toBe(13);
    expect(result.scannedCount).toBe(125);
  });

  it('does not flag a small scan below the size threshold (too few samples to judge)', () => {
    const scanned = refs(10); // below default minScanSizeForRatioCheck (30)
    const survivors = scanned.slice(0, 1); // 10% survival — would fail ratio check if size were large enough
    const result = checkScanSanity({
      scannedRefs: scanned,
      survivorRefs: survivors,
      explicitlyMappedRefs: [],
      explicitlyMappedScoredRefs: [],
    });
    expect(result.ok).toBe(true);
  });

  it('does not flag low ratio if absolute survivor count is high enough (floor check)', () => {
    // 200 scanned, 25 survivors = 12.5% ratio (below default 15%), but 25 >= floor (20)
    const scanned = refs(200);
    const survivors = scanned.slice(0, 25);
    const result = checkScanSanity({
      scannedRefs: scanned,
      survivorRefs: survivors,
      explicitlyMappedRefs: [],
      explicitlyMappedScoredRefs: [],
    });
    expect(result.ok).toBe(true);
  });

  it('respects custom thresholds', () => {
    const scanned = refs(100);
    const survivors = scanned.slice(0, 30); // 30% ratio
    const result = checkScanSanity({
      scannedRefs: scanned,
      survivorRefs: survivors,
      explicitlyMappedRefs: [],
      explicitlyMappedScoredRefs: [],
      minSurvivalRatio: 0.5, // stricter than default 0.15
      minSurvivorCountFloor: 50,
    });
    expect(result.ok).toBe(false);
  });
});

describe('checkScanSanity — explicit model-map coverage', () => {
  it('passes when all explicitly-mapped models score', () => {
    const mapped = refs(10, 'mistral/mistral-medium');
    const result = checkScanSanity({
      scannedRefs: refs(50),
      survivorRefs: refs(50),
      explicitlyMappedRefs: mapped,
      explicitlyMappedScoredRefs: mapped, // all scored
    });
    expect(result.ok).toBe(true);
  });

  it('flags when explicit model-map entries mostly fail to score (model-map/gdpval load failure)', () => {
    const mapped = refs(10, 'mistral/mistral-medium');
    const scored = mapped.slice(0, 2); // only 20% scored — model-map/gdpval likely broken
    const result = checkScanSanity({
      scannedRefs: refs(50),
      survivorRefs: refs(50).slice(0, 30), // global ratio is fine (60%)
      explicitlyMappedRefs: mapped,
      explicitlyMappedScoredRefs: scored,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/explicit model-map coverage/);
  });

  it('does not flag when too few explicitly-mapped models to judge (below size threshold)', () => {
    const mapped = refs(3, 'mistral/mistral-medium'); // below default minExplicitMapSizeForCheck (5)
    const result = checkScanSanity({
      scannedRefs: refs(50),
      survivorRefs: refs(50),
      explicitlyMappedRefs: mapped,
      explicitlyMappedScoredRefs: [], // 0% coverage, but sample too small
    });
    expect(result.ok).toBe(true);
  });

  it('reports coverage stats even when passing', () => {
    const mapped = refs(10, 'mistral/mistral-medium');
    const result = checkScanSanity({
      scannedRefs: refs(50),
      survivorRefs: refs(50),
      explicitlyMappedRefs: mapped,
      explicitlyMappedScoredRefs: mapped,
    });
    expect(result.explicitlyMappedCount).toBe(10);
    expect(result.explicitlyMappedScoredCount).toBe(10);
    expect(result.explicitMapCoverage).toBe(1);
  });
});

describe('checkScanSanity — edge cases', () => {
  it('handles zero scanned models without dividing by zero', () => {
    const result = checkScanSanity({
      scannedRefs: [],
      survivorRefs: [],
      explicitlyMappedRefs: [],
      explicitlyMappedScoredRefs: [],
    });
    expect(result.ok).toBe(true);
    expect(result.survivalRatio).toBe(1);
  });

  it('handles zero explicitly-mapped models without dividing by zero', () => {
    const result = checkScanSanity({
      scannedRefs: refs(50),
      survivorRefs: refs(50),
      explicitlyMappedRefs: [],
      explicitlyMappedScoredRefs: [],
    });
    expect(result.ok).toBe(true);
    expect(result.explicitMapCoverage).toBe(1);
  });

  it('both checks can fail simultaneously; reason reflects the first (ratio) check', () => {
    const scanned = refs(125);
    const survivors = scanned.slice(0, 13);
    const mapped = refs(10, 'mistral/mistral-medium');
    const result = checkScanSanity({
      scannedRefs: scanned,
      survivorRefs: survivors,
      explicitlyMappedRefs: mapped,
      explicitlyMappedScoredRefs: [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/scoring collapse/);
  });
});
