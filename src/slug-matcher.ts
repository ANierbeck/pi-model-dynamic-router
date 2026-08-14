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
  for (const slug of gdpvalSlugs) {
    const normalizedSlug = normalizeModelId(slug);
    if (normalized === normalizedSlug) return slug;
  }

  // Stage 2: Exclusion — only for models NOT in the GDPval DB
  if (shouldExclude(ref)) return null;

  // Stage 4: Token-set fuzzy match with version-awareness
  //
  // Token extraction: split into letters and numbers.
  // "mistralmedium2604" → letters {mistral, medium}, numbers [2604]
  // "glm52" → letters {glm}, numbers [5, 2]
  //
  // Matching rules:
  // 1. All letter-tokens of the slug must be in the ref (e.g. "medium" must match)
  // 2. If both slug and ref have version numbers, the major version must match
  //    (e.g. glm-5-x must NOT match glm-4-x — different model family)
  // 3. If the ref has no version number, accept any version (e.g. "mistral-medium-latest")
  const extractTokens = (s: string) => {
    const letters = new Set((s.match(/[a-z]+/g) ?? []));
    const numbers = (s.match(/\d+/g) ?? []).map(Number);
    return { letters, numbers };
  };

  const { letters: refLetters, numbers: refNumbers } = extractTokens(normalized);

  let bestSlug: string | undefined;
  let bestScore = 0;
  let bestSlugTokenCount = 0;

  for (const slug of gdpvalSlugs) {
    const normalizedSlug = normalizeModelId(slug);
    const { letters: slugLetters, numbers: slugNumbers } = extractTokens(normalizedSlug);

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

    // Prefer longer matches (more tokens = more specific)
    if (score > bestScore || (score === bestScore && slugLetters.size > bestSlugTokenCount)) {
      bestScore = score;
      bestSlug = slug;
      bestSlugTokenCount = slugLetters.size;
    }
  }

  // Only accept if score is high enough (all slug tokens found)
  if (bestScore >= 1.0) return bestSlug;

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

  const normalized = normalizeModelId(ref);
  const extractTokens = (s: string) => {
    const letters = new Set((s.match(/[a-z]+/g) ?? []));
    const numbers = (s.match(/\d+/g) ?? []).map(Number);
    return { letters, numbers };
  };

  const { letters: refLetters, numbers: refNumbers } = extractTokens(normalized);

  const candidates: { slug: string; score: number; tokenCount: number }[] = [];

  for (const slug of gdpvalSlugs) {
    const normalizedSlug = normalizeModelId(slug);
    const { letters: slugLetters, numbers: slugNumbers } = extractTokens(normalizedSlug);

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

    candidates.push({ slug, score, tokenCount: slugLetters.size });
  }

  // Sort by score descending, then by token count (more specific = higher)
  candidates.sort((a, b) => b.score - a.score || b.tokenCount - a.tokenCount);

  return candidates.slice(0, maxK).map(c => c.slug);
}