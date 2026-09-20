// src/slug-matcher.ts
// Automatic model-ID → GDPval-slug matching.
// Replaces the manual model-map.yaml with an algorithmic approach.

/**
 * The matching pipeline (4 stages, no manual mapping):
 *
 * 1. NORMALIZE: Strip vendor prefixes, date suffixes, -latest, parameter tags
 * 2. EXCLUDE: Identify small/special models that have no GDPval benchmark
 * 3. EXACT: Try exact match against GDPval slugs (after normalization)
 * 4. FUZZY: Token-set overlap with version-aware normalization
 *    (e.g. "mistral-medium-2604" → {mistral,medium} → matches "mistral-medium-3-5")
 */

// ── Stage 1: Normalization ────────────────────────────────────────────────

// Date suffixes: -2512, -2604, -2505, -2508, -20250514, -0324
const DATE_SUFFIX_RE = /-(?:\d{4}|\d{6}|\d{8})$/g;

// "-latest", "-preview", "-chat", "-instruct", "-thinking", etc.
const TAG_SUFFIXES = [
  '-latest', '-preview', '-chat', '-instruct', '-thinking',
  '-reasoning', '-tee', '-fp8', '-adaptive', '-non-reasoning',
];

// Vendor prefixes that should be stripped: "zai-glm-5-2" → "glm-5-2"
// Note: "mistral-" is NOT a vendor prefix here — "mistral-medium" is a model name,
// not a vendor prefix. Only strip prefixes that are clearly vendor tags.
const VENDOR_PREFIXES = ['zai-'];

/**
 * Strip the provider prefix from a model ref.
 * "mistral-zai/devstral-2512" → "devstral-2512"
 * "ollama/gemma4:12b-mlx" → "gemma4:12b-mlx"
 */
export function stripProviderPrefix(ref: string): string {
  const slash = ref.lastIndexOf('/');
  if (slash !== -1 && slash < ref.length - 1) return ref.slice(slash + 1);
  return ref;
}

/**
 * Normalize a model ID for matching.
 * Strips: provider prefix, vendor prefix, date suffixes, tag suffixes, :free, :latest,
 *         ollama tags (:mlx, :q4, etc.)
 * Lowercases and removes special chars.
 *
 * "mistral-zai/mistral-medium-2604" → "mistralmedium"
 * "devstral-2512" → "devstral"
 * "zai-glm-5-2" → "glm52"
 * "mistral-medium-3.5" → "mistralmedium35"
 * "ollama/gemma4:12b-mlx" → "gemma412b"
 */
export function normalizeModelId(ref: string): string {
  let s = stripProviderPrefix(ref).toLowerCase();

  // Strip ollama quantization tags: :mlx, -mlx, :q4_0, :f16, etc.
  // These appear AFTER the model name and are NOT part of the GDPval slug.
  // But keep parameter counts like :12b, :7b which ARE part of the slug.
  // Only strip pure quantization tags: :mlx, -mlx, :q4_0, :f16, :f32, etc.
  s = s.replace(/[-:](?:mlx|q[0-9](?:_[0-9]+)?|f?16|f?32|iq[0-9]_[a-z]+|fp[0-9]+)$/g, '');

  // Strip :free, :latest, :api suffixes
  s = s.replace(/:(?:free|latest|api)$/g, '');

  // Strip vendor prefixes (zai-glm → glm)
  for (const vp of VENDOR_PREFIXES) {
    if (s.startsWith(vp)) {
      s = s.slice(vp.length);
      break;
    }
  }

  // Strip tag suffixes (-latest, -instruct, etc.)
  for (const tag of TAG_SUFFIXES) {
    s = s.replace(new RegExp(tag + '$', 'g'), '');
  }

  // Strip date suffixes (-2512, -2604, -20250514)
  s = s.replace(DATE_SUFFIX_RE, '');

  // Remove special chars (keep alphanumerics)
  s = s.replace(/[^a-z0-9]/g, '');

  return s;
}

/**
 * Same normalization pipeline as normalizeModelId, but separator runs become
 * SPACES instead of being removed. Used for Stage 4 token extraction so that
 * multi-word names tokenize into separate letter-tokens
 * ("devstral-small" → {devstral, small}) and version segments stay separate
 * numbers ("3-5" → [3, 5], not the concatenated [35]).
 *
 * Why this matters (2026-09-20 design,
 * docs/plans/2026-09-20-latest-alias-slug-matching-design.md):
 * - The concatenated form made subset matching impossible: slug `devstral`
 * (token {devstral}) was never a subset of ref `devstral-small-2505`
 * (token {devstralsmall} — one unbreakable mega-token) → GDPval null.
 * - Concatenated versions ([35] from "3-5") cannot be compared for the
 * newest-version tie-break and made bare-major refs (`glm-5`, numbers [5])
 * incompatible with their own family slugs ([52]).
 */
export function normalizeSpacedId(ref: string): string {
  let s = stripProviderPrefix(ref).toLowerCase();

  s = s.replace(/[-:](?:mlx|q[0-9](?:_[0-9]+)?|f?16|f?32|iq[0-9]_[a-z]+|fp[0-9]+)$/g, '');
  s = s.replace(/:(?:free|latest|api)$/g, '');

  for (const vp of VENDOR_PREFIXES) {
    if (s.startsWith(vp)) {
      s = s.slice(vp.length);
      break;
    }
  }

  for (const tag of TAG_SUFFIXES) {
    s = s.replace(new RegExp(tag + '$', 'g'), '');
  }

  s = s.replace(DATE_SUFFIX_RE, '');

  // Separator runs become spaces (keep alphanumerics)
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Extracts letter-tokens and version numbers from a SPACED normalized id.
 * Letters: [a-z]+ runs; numbers: \d+ runs — "mistral medium 3 5" →
 * letters {mistral, medium}, numbers [3, 5].
 *
 * `version` is the ORDERING tuple with multi-digit runs split digit-wise
 * ('glm-52' → [5,2], 'mistral-small-2603' → [2,6,0,3]). GDPval scrapes
 * write dotted versions without dashes ('glm-53' = GLM 5.3), and a
 * concatenated run parsed whole ([53]) beats every real multi-part
 * version ([5,3]: 53 > 5) in -latest resolution — 2026-09-20 this made
 * zai-glm-latest resolve to 'glm-52'/'glm-53' instead of 'glm-5-3'.
 * Raw `numbers` stay intact: exact matching must NOT equate a 'glm-5.2'
 * ref with slug 'glm-52' (GDPval's non-reasoning variant).
 */
function extractTokens(s: string): { letters: Set<string>; numbers: number[]; version: number[] } {
  const letters = new Set(s.match(/[a-z]+/g) ?? []);
  const numbers: number[] = [];
  const version: number[] = [];
  for (const run of s.match(/\d+/g) ?? []) {
    const n = Number(run);
    numbers.push(n);
    if (run.length >= 2) {
      for (const d of run.split('')) version.push(Number(d));
    } else {
      version.push(n);
    }
  }
  return { letters, numbers, version };
}

/**
 * Element-wise version-tuple comparison; a shorter prefix counts as LOWER
 * (glm-4 [4] < glm-4-6 [4,6], mistral-small-3-1 [3,1] < [3,2]). Used as the
 * newest-version tie-break among equal-score slug candidates so `-latest`
 * aliases and dated snapshots resolve to the NEWEST version of their family
 * instead of whichever slug iterates first.
 */
function versionTupleGT(a: number[], b: number[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return a.length > b.length;
}

/**
 * Sort key for slug candidates. Order of precedence:
 *   1. score (letter-overlap) descending,
 *   2. EXACT version-tuple match beats non-exact — so `gemma4:12b` [4,12]
 *      picks slug `gemma4-12b` [4,12] over `gemma4-27b` [4,27] (parameter
 *      counts are sizes, not "newer is better"), while a version-less ref
 *      (`-latest`, dated snapshot) has no exact match and falls through to
 *      the newest-version tie-break below,
 *   3. NEWEST version tuple first — `-latest` and dated snapshots resolve
 *      to the newest version of their family (mistral-small-latest → 3-2),
 *   4. more letter-tokens first (more specific match).
 */
interface CandRank { score: number; exact: boolean; tuple: number[]; tokenCount: number }
function compareCand(a: CandRank, b: CandRank): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.exact !== b.exact) return a.exact ? -1 : 1;
  if (versionTupleGT(b.tuple, a.tuple)) return 1;
  if (versionTupleGT(a.tuple, b.tuple)) return -1;
  return b.tokenCount - a.tokenCount;
}
function isExactTuple(slugNums: number[], refNums: number[]): boolean {
  return slugNums.length === refNums.length && slugNums.every((n, i) => n === refNums[i]);
}

// ── Stage 2: Exclusion ────────────────────────────────────────────────────

// Small models (by parameter count) that are too weak for GDPval benchmarks.
// Only matches standalone size tags (e.g. "ministral-3b", "llama-3.2-3b").
// Does NOT match when the size is part of the model family name (e.g. "gemma4-12b"
// is a GDPval slug, "mistral-small-3-1" has "small" but is a real model).
// We check this AFTER exact match, so models in the GDPval DB are never excluded.
const SMALL_MODEL_PATTERNS = [
  /\bministral-\d+b\b/i,
  /\bministral-\d+b-/i,
];

// Special-purpose models that are not for general LLM routing
const SPECIAL_MODEL_RE = /\b(ocr|voxtral|vibe|whisper|tts|embed|guard|safety|moderation|fim|rerank|audio|transcri)\b/i;

/**
 * Determine if a model should be EXCLUDED from routing (null GDPval).
 * Returns true if the model is too small or a special-purpose model.
 * Note: This is checked AFTER exact match, so models in the GDPval DB
 * are never excluded.
 */
export function shouldExclude(ref: string): boolean {
  const id = stripProviderPrefix(ref).toLowerCase();

  // Special-purpose models: OCR, voice, embedding, etc.
  if (SPECIAL_MODEL_RE.test(id)) return true;

  // Small models: ministral-3b, ministral-8b, etc.
  for (const pattern of SMALL_MODEL_PATTERNS) {
    if (pattern.test(id)) return true;
  }

  return false;
}

// ── Stage 3+4: Matching against GDPval slugs ──────────────────────────────

/**
 * Match a model ref to a GDPval slug.
 * Returns the slug, or null if excluded, or undefined if no match found.
 *
 * Pipeline:
 * 1. Check exclusion rules → null
 * 2. Exact normalized match → slug
 * 3. Token-set fuzzy match → slug
 */
export function matchSlug(
  ref: string,
  gdpvalSlugs: string[]
): string | null | undefined {
  const normalized = normalizeModelId(ref);

  // Stage 3: Exact match (after normalization) — check FIRST, before exclusion.
  // This ensures models like "gemma2:2b" (which IS in the GDPval DB) are matched
  // even though they have a parameter count in the name.
  // Normalize BOTH the ref and the slug the same way.
  //
  // Dash-erasing makes DIFFERENT slugs normalize identically: 'glm-5-2' ≡
  // 'glm-52' (both 'glm52'). GDPval carries both as distinct models
  // (reasoning vs non-reasoning, different scores), so among equal-normalized
  // slugs prefer the one whose SPACED number tuple exactly matches the
  // ref's — ref 'glm-5.2' [5,2] picks slug 'glm-5-2', ref 'glm-52' [52]
  // picks slug 'glm-52' (2026-09-20: without this, iteration order decided
  // and 'mistral/glm-52' scored as glm-5-2, the wrong model).
  const refNums = extractTokens(normalizeSpacedId(ref)).numbers;
  let exactNumHit: string | undefined;
  let exactHit: string | undefined;
  for (const slug of gdpvalSlugs) {
    const normalizedSlug = normalizeModelId(slug);
    if (normalized !== normalizedSlug) continue;
    if (exactNumHit === undefined && isExactTuple(extractTokens(normalizeSpacedId(slug)).numbers, refNums)) {
      exactNumHit = slug;
    } else if (exactHit === undefined) {
      exactHit = slug;
    }
  }
  if (exactNumHit !== undefined) return exactNumHit;
  if (exactHit !== undefined) return exactHit;

  // Stage 2: Exclusion — only for models NOT in the GDPval DB
  if (shouldExclude(ref)) return null;

  // Stage 4: Token-set fuzzy match with version-awareness
  //
  // Token extraction: split into letters and numbers.
  // "mistral medium 2604" → letters {mistral, medium}, numbers [2604]
  // "glm 5 2" → letters {glm}, numbers [5, 2]
  // (Numbers stay SEPARATE — see normalizeSpacedId — so version tuples can
  // be compared for the newest-version tie-break.)
  //
  // Matching rules:
  // 1. All letter-tokens of the slug must be in the ref (e.g. "medium" must match)
  // 2. If both slug and ref have version numbers, the major version must match
  //    (e.g. glm-5-x must NOT match glm-4-x — different model family)
  // 3. If the ref has no version number, accept any version (e.g. "mistral-medium-latest",
  //    or dated snapshots whose date suffix was stripped by normalizeSpacedId)
  //
  // Tie-break among equal-score candidates (see compareCand): an EXACT
  // version-tuple match wins (gemma4:12b → gemma4-12b, not gemma4-27b);
  // otherwise the NEWEST version wins (-latest / dated snapshot → newest
  // family version); then more letter-tokens (more specific).
  const { letters: refLetters, numbers: refNumbers } = extractTokens(normalizeSpacedId(ref));

  let bestSlug: string | undefined;
  let best: CandRank | undefined;

  for (const slug of gdpvalSlugs) {
    const { letters: slugLetters, numbers: slugNumbers, version: slugVersion } = extractTokens(normalizeSpacedId(slug));

    // Rule 1: All slug letter-tokens must be in ref
    const refHasAllSlugLetters = [...slugLetters].every(t => refLetters.has(t));
    if (!refHasAllSlugLetters) continue;

    // Rule 2: If both have version numbers, major version must match
    // e.g. slug "glm-5-2" (major 5) must not match ref "glm-4" (major 4)
    if (slugNumbers.length > 0 && refNumbers.length > 0) {
      const slugMajor = slugNumbers[0];
      const refMajor = refNumbers[0];
      if (slugMajor !== refMajor) continue;
    }

    // Score: how many slug letter-tokens are in the ref?
    const overlap = [...slugLetters].filter(t => refLetters.has(t)).length;
    const score = overlap / slugLetters.size;
    const cand: CandRank = {
      score,
      exact: isExactTuple(slugNumbers, refNumbers),
      tuple: slugVersion,
      tokenCount: slugLetters.size,
    };
    if (best === undefined || compareCand(cand, best) < 0) {
      best = cand;
      bestSlug = slug;
    }
  }

  // Only accept if score is high enough (all slug tokens found)
  if (best !== undefined && best.score >= 1.0) return bestSlug;

  return undefined;
}

/**
 * Return the TOP-K candidate GDPval slugs for a model ref, sorted by score.
 * This is used as a PRE-FILTER for the LLM matcher: instead of sending all
 * 60+ GDPval slugs to the LLM, we send only the 3-5 most plausible candidates.
 * The LLM then only needs to VERIFY or CORRECT, not search from scratch.
 *
 * Returns up to `maxK` slugs, sorted by descending score.
 * Returns empty array if the model is excluded or no candidates found.
 */
export function candidateSlugs(
  ref: string,
  gdpvalSlugs: string[],
  maxK: number = 5
): string[] {
  // Check exclusion first
  if (shouldExclude(ref)) return [];

  const { letters: refLetters, numbers: refNumbers } = extractTokens(normalizeSpacedId(ref));

  const candidates: { slug: string; rank: CandRank }[] = [];

  for (const slug of gdpvalSlugs) {
    const { letters: slugLetters, numbers: slugNumbers, version: slugVersion } = extractTokens(normalizeSpacedId(slug));

    // Rule 1: All slug letter-tokens must be in ref
    const refHasAllSlugLetters = [...slugLetters].every(t => refLetters.has(t));
    if (!refHasAllSlugLetters) continue;

    // Rule 2: If both have version numbers, major version must match
    if (slugNumbers.length > 0 && refNumbers.length > 0) {
      const slugMajor = slugNumbers[0];
      const refMajor = refNumbers[0];
      if (slugMajor !== refMajor) continue;
    }

    // Score: how many slug letter-tokens are in the ref?
    const overlap = [...slugLetters].filter(t => refLetters.has(t)).length;
    const score = overlap / slugLetters.size;

    candidates.push({
      slug,
      rank: { score, exact: isExactTuple(slugNumbers, refNumbers), tuple: slugVersion, tokenCount: slugLetters.size },
    });
  }

  // Sort by the shared candidate ranker (see compareCand): exact version
  // match first, then newest version, then specificity — so the LLM pre-filter
  // is presented the same ordering matchSlug would pick.
  candidates.sort((a, b) => compareCand(a.rank, b.rank));

  return candidates.slice(0, maxK).map((c) => c.slug);
}