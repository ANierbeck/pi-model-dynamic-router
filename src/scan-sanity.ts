// src/scan-sanity.ts
// Sanity checks for generateDynamicConfig(), run BEFORE persisting the
// scan result to router-config.dynamic.json.
//
// WHY: router-config.dynamic.json is a generated snapshot that is reused
// for up to 30 days (see CacheManager.isScanCacheValid). A single bad
// generation — e.g. gdpval state not fully loaded at the moment of scoring,
// a transient race during a scan — freezes every model group's candidate
// list at whatever the broken snapshot contained, since resolveGroup()
// treats a non-empty `models` array as a hard allow-list. This was observed
// 2026-08-22: a generation run scored only 13/125 scanned models (instead of
// the normal ~60+), so mistral-medium (933 GDPval) silently vanished from
// "tactical" and stayed vanished for hours across many session restarts,
// because nothing ever re-triggered a scan.
//
// These checks catch that failure MODE (not the root cause, which may be a
// one-off race) so a bad scan can never again get silently persisted and
// frozen. Detection is deliberately coarse and conservative — false
// positives just cost one extra scan retry; false negatives leave a broken
// config live for up to 30 days. Erring toward "reject" is the right trade.

interface ScanSanityParams {
  /** All refs considered for scoring, after exclude rules (effectiveModelRefs). */
  scannedRefs: string[];
  /** Refs that ended up with a usable GDPval score (modelsWithMetadata). */
  survivorRefs: string[];
  /**
   * Refs that have an EXPLICIT (non-null) model-map.yaml entry — i.e.
   * mapLookup(ref) returned a string slug, not undefined/null. These are
   * curated, high-confidence mappings; if a meaningful fraction of them
   * fail to score, the model-map or gdpval state almost certainly didn't
   * load correctly for this scan.
   */
  explicitlyMappedRefs: string[];
  /** Subset of explicitlyMappedRefs that scored a GDPval > 0. */
  explicitlyMappedScoredRefs: string[];
  /** Below this scanned-model count, the ratio check is skipped (too small a sample to be meaningful). Default 30. */
  minScanSizeForRatioCheck?: number;
  /** Minimum survivor/scanned ratio before flagging a collapse. Default 0.15 (15%). */
  minSurvivalRatio?: number;
  /** Survivor count floor — ratio check only fires if survivors are ALSO below this absolute count. Default 20. */
  minSurvivorCountFloor?: number;
  /** Below this explicitly-mapped count, the coverage check is skipped (too small a sample). Default 8. */
  minExplicitMapSizeForCheck?: number;
  /**
   * Minimum fraction of explicitly-mapped refs that must score > 0. Default
   * 0.4 (40%) — deliberately loose: a model-map.yaml entry can legitimately
   * map to a slug with no known GDPval yet (e.g. a newly-tracked model added
   * to the map before a score was found for it), so real-world coverage can
   * sit well below 100% without anything being broken (observed ~74% on a
   * healthy production scan). This check exists to catch "nothing resolves"
   * (model-map.yaml failed to load / gdpval state empty), not to enforce
   * complete score coverage — that's a data-curation concern, not a sanity one.
   */
  minExplicitMapCoverage?: number;
  /**
   * Survivor count of the dynamic config currently on disk (`_dynamic.model_count`).
   * A new scan that shrinks far below it is refused (check 3): small scans skip
   * check 1, so a 1-model snapshot (e.g. registry not ready at session start)
   * used to overwrite a good 37-model config.
   */
  previousSurvivorCount?: number;
  /** True when excludes/providers/groups changed since that snapshot: a shrink is then expected. */
  configChanged?: boolean;
  /** Check 3 only applies when the previous snapshot had at least this many survivors. Default 10. */
  minPreviousForRegressionCheck?: number;
  /** Refuse when survivors fall below this fraction of the previous count. Default 0.5. */
  minRetainedRatio?: number;
}

interface ScanSanityResult {
  ok: boolean;
  reason?: string;
  /** Which check refused the scan. */
  check?: 'collapse' | 'coverage' | 'regression';
  scannedCount: number;
  survivorCount: number;
  survivalRatio: number;
  explicitlyMappedCount: number;
  explicitlyMappedScoredCount: number;
  explicitMapCoverage: number;
}

/**
 * Checks whether a scan's scoring results look sane enough to persist.
 * Returns { ok: false, reason } if the scan looks like a scoring collapse
 * (GDPval state failed to load, model-map didn't apply, etc.) — the caller
 * should skip persisting router-config.dynamic.json and skip bumping
 * lastScanTimestamp, so the next session retries instead of freezing a
 * broken snapshot for up to 30 days.
 */
export function checkScanSanity(params: ScanSanityParams): ScanSanityResult {
  const {
    scannedRefs,
    survivorRefs,
    explicitlyMappedRefs,
    explicitlyMappedScoredRefs,
    minScanSizeForRatioCheck = 30,
    minSurvivalRatio = 0.15,
    minSurvivorCountFloor = 20,
    minExplicitMapSizeForCheck = 8,
    minExplicitMapCoverage = 0.4,
    previousSurvivorCount,
    configChanged = false,
    minPreviousForRegressionCheck = 10,
    minRetainedRatio = 0.5,
  } = params;

  const scannedCount = scannedRefs.length;
  const survivorCount = survivorRefs.length;
  const survivalRatio = scannedCount > 0 ? survivorCount / scannedCount : 1;

  const explicitlyMappedCount = explicitlyMappedRefs.length;
  const explicitlyMappedScoredCount = explicitlyMappedScoredRefs.length;
  const explicitMapCoverage = explicitlyMappedCount > 0 ? explicitlyMappedScoredCount / explicitlyMappedCount : 1;

  const result: ScanSanityResult = {
    ok: true,
    scannedCount,
    survivorCount,
    survivalRatio,
    explicitlyMappedCount,
    explicitlyMappedScoredCount,
    explicitMapCoverage,
  };

  // Check 1: global scoring collapse. Only meaningful once there's a
  // reasonably sized scan — a handful of models with low survival is normal
  // (e.g. a fresh install with few providers configured).
  if (
    scannedCount >= minScanSizeForRatioCheck &&
    survivorCount < minSurvivorCountFloor &&
    survivalRatio < minSurvivalRatio
  ) {
    return {
      ...result,
      ok: false,
      check: 'collapse',
      reason:
        `scoring collapse: only ${survivorCount}/${scannedCount} scanned models ` +
        `(${(survivalRatio * 100).toFixed(1)}%) received a usable GDPval score — ` +
        `expected far more. This usually means gdpval state or model-map.yaml ` +
        `didn't fully load for this scan.`,
    };
  }

  // Check 2: explicit model-map coverage. These are curated, high-confidence
  // mappings (e.g. mistral-medium-latest → mistral-medium-3-5). If a
  // meaningful fraction fail to resolve to a score, something is broken in
  // the scoring pipeline itself, independent of scan size.
  if (
    explicitlyMappedCount >= minExplicitMapSizeForCheck &&
    explicitMapCoverage < minExplicitMapCoverage
  ) {
    return {
      ...result,
      ok: false,
      check: 'coverage',
      reason:
        `explicit model-map coverage too low: only ${explicitlyMappedScoredCount}/` +
        `${explicitlyMappedCount} explicitly-mapped models (${(explicitMapCoverage * 100).toFixed(1)}%) ` +
        `scored > 0 — expected near 100%. model-map.yaml or gdpval_builtin likely ` +
        `didn't load correctly for this scan.`,
    };
  }

  // Check 3: regression against the snapshot on disk. Catches collapses that
  // are too small for check 1 (it skips scans under minScanSizeForRatioCheck).
  if (
    !configChanged &&
    previousSurvivorCount !== undefined &&
    previousSurvivorCount >= minPreviousForRegressionCheck &&
    survivorCount < previousSurvivorCount * minRetainedRatio
  ) {
    return {
      ...result,
      ok: false,
      check: 'regression',
      reason:
        `regression vs. the persisted snapshot: ${survivorCount} usable models now, ` +
        `${previousSurvivorCount} before, with an unchanged config. This usually means ` +
        `discovery ran before the model registry was ready. If the next scan returns the ` +
        `same result it is accepted as real; /router scan accepts it now.`,
    };
  }

  return result;
}
