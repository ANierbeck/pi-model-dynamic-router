// src/model-matcher.ts
// LLM-assisted model → GDPval slug matching.
//
// The router discovers models from many providers (Mistral, OpenRouter, Ollama,
// LM Studio, ...). Each model needs a GDPval score to be eligible for routing
// groups. Scores come from a scraped benchmark table keyed by *slugs* (e.g.
// "glm-5-2"), but provider model ids are often different strings
// (e.g. "zai-glm-5-2", "mistral/zlm-5-2-tee").
//
// Matching pipeline (precedence high → low):
//   1. model-map.yaml  (authoritative; supports wildcards + explicit null = exclude)
//   2. token-set fallback (cheap, deterministic; fails on vendor prefixes)
//   3. LLM match (one batched call per scan; semantic; the safety net)
//
// This module contains the PURE parts (prompt building, response parsing,
// score resolution) plus the orchestrator that drives a single LLM call.
// The LLM caller itself is injected so tests need no network.

import { baseTokens } from './utils.js';
import { stripDateSuffix } from './utils.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface GdpvalEntry {
  slug: string;
  /** Human-readable display name from the benchmark table (e.g. "GLM 5.2"). */
  label: string;
  score: number;
}

/**
 * Function that takes a prompt and returns the LLM's text response.
 * Throws on failure (caller treats throw as "no matches this round").
 */
export type LlmCaller = (prompt: string) => Promise<string>;

export interface MatchResult {
  /** modelId → gdpval slug, only for confident + valid matches. */
  matches: Record<string, string>;
  /** modelIds the LLM could not (or would not) match. */
  unmatched: string[];
  /** Error message if the LLM call itself failed (e.g. Ollama down). */
  error?: string | undefined;
}

export interface ResolveScoresInput {
  modelRefs: string[];
  gdpvalScores: Record<string, number>;
  modelMap: Record<string, string | null>;
  modelMapWildcards: [string, string | null][];
  /** LLM matches: modelRef → gdpval slug (already validated to exist). */
  llmMatches?: Record<string, string>;
}

// ── Prompt building ───────────────────────────────────────────────────────

/**
 * Build the prompt sent to the LLM to match unscored model ids to GDPval slugs.
 *
 * Design:
 * - Lists every unscored model id verbatim (the LLM must echo these as keys).
 * - Lists every known GDPval entry as slug + label so the LLM can do semantic
 *   matching (e.g. "zai-glm-5-2" ↔ "GLM 5.2" / "glm-5-2").
 * - Demands strict JSON keyed by the input model id, value = slug.
 * - Tells the LLM to OMIT a model if it is not confident — partial responses
 *   are fine; hallucinated slugs are rejected by parseMatchResponse anyway.
 */
export function buildMatchPrompt(
  modelIds: string[],
  gdpvalEntries: GdpvalEntry[]
): string {
  const modelsBlock =
    modelIds.length === 0
      ? '(no models to match)'
      : modelIds.map((m) => `- ${m}`).join('\n');

  const candidatesBlock = gdpvalEntries
    .map((g) => `- slug: "${g.slug}"  (display name: "${g.label}", score: ${g.score})`)
    .join('\n');

  return `You are a model-name matcher. Match each provider model ID to the benchmark slug that refers to the SAME underlying model.

# Model IDs to match
${modelsBlock}

# Known benchmark entries (slug | display name | GDPval score)
${candidatesBlock}

# Matching rules
- Output ONLY a JSON object mapping model ID → slug.
- Use the EXACT model ID string from the list above as the key.
- Use the EXACT slug string from the list above as the value.
- Match the MODEL FAMILY and VENDOR: a model from one vendor must NOT match
  a slug from a different vendor. E.g. a Mistral model matches a Mistral slug,
  a Claude model matches a Claude slug, an OpenAI model matches a GPT slug.
  Never cross-match across vendors (mistral → claude, qwen → gpt, etc.).
- Match the VERSION NUMBER precisely: "glm-5-2" matches "glm-5-2", NOT "glm-4".
  Different version numbers mean different models.
- Match the MODEL SIZE/TIER: a small model (parameter counts like 3b, 7b, 8b,
  or small-tier names like "mini", "nano", "haiku") must NOT match a slug for a
  larger tier ("medium", "large", "opus", "ultra", "max", "pro").
- If you are not confident a model ID matches any entry, OMIT it from the output.
- Do NOT invent slugs. Do NOT include commentary. Do NOT use markdown fences.
- Ignore vendor prefixes (e.g. "zai-", "mistral/", "chutes/"), quantization tags
  (-FP8), TEE suffixes, and date/version tags when matching.

# Output
{"<model-id>": "<slug>", ...}`;
}

// ── Plausibility check (prevents cross-family hallucinations) ──────────────

/**
 * Known model families. A match is plausible if the model id and the slug
 * share at least one family token. This prevents the LLM from matching
 * "mistral/mistral-medium-2604" → "claude-opus-5" (cross-family hallucination).
 */
const MODEL_FAMILIES: { tokens: string[]; family: string }[] = [
  { tokens: ['claude', 'opus', 'sonnet', 'haiku', 'fable'], family: 'anthropic' },
  { tokens: ['mistral', 'magistral', 'ministral', 'codestral', 'devstral', 'pixtral', 'voxtral', 'nemo'], family: 'mistral' },
  { tokens: ['gpt', 'openai'], family: 'openai' },
  { tokens: ['gemini', 'gemma'], family: 'google' },
  { tokens: ['llama'], family: 'meta' },
  { tokens: ['qwen'], family: 'qwen' },
  { tokens: ['glm', 'zai', 'zhipu'], family: 'zhipu' },
  { tokens: ['grok'], family: 'xai' },
  { tokens: ['deepseek'], family: 'deepseek' },
  { tokens: ['minimax'], family: 'minimax' },
  { tokens: ['mimo'], family: 'xiaomi' },
  { tokens: ['kimi', 'moonshot'], family: 'moonshot' },
  { tokens: ['nemotron', 'nvidia'], family: 'nvidia' },
  { tokens: ['granite'], family: 'ibm' },
  { tokens: ['ornith'], family: 'ornith' },
];

/**
 * Determine if a model-id → slug match is plausible: they must share at
 * least one model-family token. E.g. "mistral/..." → "mistral-..." is OK,
 * but "mistral/..." → "claude-..." is NOT plausible.
 *
 * This is a SAFETY NET only — the primary rules (size-tier, version
 * precision) are conveyed to the LLM via buildMatchPrompt(). This guard
 * catches cross-family hallucinations the LLM might still produce.
 */
export function isPlausibleMatch(modelId: string, slug: string): boolean {
  const lowerModel = modelId.toLowerCase();
  const lowerSlug = slug.toLowerCase();

  // Find which families the model and slug belong to.
  const modelFamilies = new Set<string>();
  const slugFamilies = new Set<string>();
  for (const { tokens, family } of MODEL_FAMILIES) {
    if (tokens.some((t) => lowerModel.includes(t))) modelFamilies.add(family);
    if (tokens.some((t) => lowerSlug.includes(t))) slugFamilies.add(family);
  }

  // If neither has a known family, allow it (we can't judge).
  if (modelFamilies.size === 0 || slugFamilies.size === 0) return true;

  // Plausible if they share at least one family.
  for (const f of modelFamilies) {
    if (slugFamilies.has(f)) return true;
  }
  return false;
}

// ── Response parsing (with hallucination guard) ──────────────────────────

/**
 * Parse the LLM response into a validated { modelId → slug } map.
 *
 * Safety:
 * - Strips markdown code fences and extracts the first JSON object.
 * - Drops any value that is not a non-empty string.
 * - Drops any value (slug) that is NOT in `validSlugs` — this is the
 *   hallucination guard. The LLM cannot inject a fabricated slug.
 * - Never throws: returns {} on any parse failure (fail-safe).
 */
export function parseMatchResponse(
  raw: string,
  validSlugs: Set<string>
): Record<string, string> {
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (!validSlugs.has(value)) continue; // reject hallucinated slug
    result[key] = value;
  }
  return result;
}

/**
 * Extract the first {...} JSON object from a possibly-noisy string.
 * Handles markdown fences and surrounding prose.
 */
function extractJsonObject(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim();

  // Strip a leading ```json or ``` fence and trailing fence.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // If fenced content remains mid-string, grab the first {...} block.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

// ── LLM orchestration ────────────────────────────────────────────────────

export interface MatchWithLlmInput {
  modelIds: string[];
  gdpvalEntries: GdpvalEntry[];
  callLlm: LlmCaller;
}

/**
 * Drive a single batched LLM call to match model ids → gdpval slugs.
 *
 * - Batches ALL model ids into ONE call (regardless of count).
 * - Rejects any slug not present in gdpvalEntries (hallucination guard).
 * - Fail-open: if callLlm throws, returns { matches: {}, unmatched: all, error }.
 * - If modelIds is empty, does not call the LLM at all.
 */
export async function matchModelsWithLLM(
  input: MatchWithLlmInput
): Promise<MatchResult> {
  const { modelIds, gdpvalEntries, callLlm } = input;

  if (modelIds.length === 0) {
    return { matches: {}, unmatched: [] };
  }

  const validSlugs = new Set(gdpvalEntries.map((g) => g.slug));
  const prompt = buildMatchPrompt(modelIds, gdpvalEntries);

  let raw: string;
  try {
    raw = await callLlm(prompt);
  } catch (err) {
    return {
      matches: {},
      unmatched: [...modelIds],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const parsed = parseMatchResponse(raw, validSlugs);

  // Only keep matches for ids we actually asked about AND that are plausible
  // (same model family — prevents cross-family hallucinations like
  // mistral-medium → claude-opus-5).
  const requestedSet = new Set(modelIds);
  const matches: Record<string, string> = {};
  const unmatched: string[] = [];
  for (const id of modelIds) {
    const slug = parsed[id];
    if (slug && requestedSet.has(id) && isPlausibleMatch(id, slug)) {
      matches[id] = slug;
    } else {
      unmatched.push(id);
    }
  }

  return { matches, unmatched };
}

// ── Batched LLM matching (for large model sets) ───────────────────────────

/**
 * Pre-filter: keep only model ids whose MODEL NAME (after the provider prefix)
 * shares at least one significant token with some gdpval slug.
 *
 * A "significant" token is an alphabetic run of length ≥ 3 (so "glm",
 * "claude", "mistral" count, but "5", "2", "v4" do not).
 *
 * IMPORTANT: we strip the provider prefix (e.g. "mistral/") before
 * extracting tokens, otherwise every mistral/* model would match the slug
 * token "mistral" and nothing would be filtered out. We compare the
 * model's name-tokens against the gdpval slug's name-tokens.
 *
 * This drastically shrinks the candidate list sent to the LLM (425 → ~30)
 * because most discovered models (voxtral-mini-2602, ministral-3b, etc.)
 * have no benchmark entry and would only waste prompt budget + produce noise.
 */
export function plausibleMatchCandidates(
  modelIds: string[],
  gdpvalEntries: GdpvalEntry[]
): string[] {
  // Collect significant tokens from gdpval SLUGS (slugs have no provider prefix).
  const sigTokens = new Set<string>();
  for (const g of gdpvalEntries) {
    for (const tok of g.slug.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
      sigTokens.add(tok);
    }
  }
  if (sigTokens.size === 0) return [];

  return modelIds.filter((id) => {
    // Strip provider prefix: "mistral-zai/zai-glm-5-2" → "zai-glm-5-2".
    // Use lastIndexOf so "openrouter/anthropic/claude-opus" → "claude-opus".
    const slash = id.lastIndexOf('/');
    const modelName = slash === -1 ? id : id.slice(slash + 1);
    const idTokens = modelName.toLowerCase().match(/[a-z]{3,}/g) ?? [];
    return idTokens.some((t) => sigTokens.has(t));
  });
}

/**
 * Drive LLM matching in BATCHES to avoid overwhelming a small local model.
 *
 * A single 400+ model prompt causes gemma2:2b to produce malformed JSON
 * (multiple objects, truncated output, key/value inversion). Batching keeps
 * each prompt ≤ BATCH_SIZE models so the LLM can emit one clean JSON object.
 *
 * Also applies plausibleMatchCandidates() first to shrink the list — models
 * with no significant token overlap with any gdpval slug are skipped (they'd
 * only be unmatched anyway, and they bloat the prompt).
 *
 * Fail-open: any batch error is logged via the returned error only for that
 * batch; other batches still run. Unmatched models across all batches are
 * collected.
 */
export async function matchModelsWithLLMBatched(
  input: MatchWithLlmInput & { batchSize?: number }
): Promise<MatchResult> {
  const { modelIds, gdpvalEntries, callLlm, batchSize = 40 } = input;

  if (modelIds.length === 0) {
    return { matches: {}, unmatched: [] };
  }

  // Pre-filter to plausible candidates.
  const plausible = plausibleMatchCandidates(modelIds, gdpvalEntries);
  const plausibleSet = new Set(plausible);
  // Models that were filtered OUT are not "unmatched by LLM" — they're
  // considered not-matchable and are NOT reported as unmatched (to avoid
  // log noise). Only plausible-but-LLM-unmatched models count.
  const filteredOut = modelIds.filter((id) => !plausibleSet.has(id));

  if (plausible.length === 0) {
    return { matches: {}, unmatched: [] };
  }

  const validSlugs = new Set(gdpvalEntries.map((g) => g.slug));
  const allMatches: Record<string, string> = {};
  const allUnmatched: string[] = [];
  let batchError: string | undefined;

  for (let i = 0; i < plausible.length; i += batchSize) {
    const batch = plausible.slice(i, i + batchSize);
    const prompt = buildMatchPrompt(batch, gdpvalEntries);

    let raw: string;
    try {
      raw = await callLlm(prompt);
    } catch (err) {
      // Record the error but continue with other batches.
      batchError = err instanceof Error ? err.message : String(err);
      allUnmatched.push(...batch);
      continue;
    }

    const parsed = parseMatchResponse(raw, validSlugs);
    const requestedSet = new Set(batch);
    for (const id of batch) {
      const slug = parsed[id];
      if (slug && requestedSet.has(id) && isPlausibleMatch(id, slug)) {
        allMatches[id] = slug;
      } else {
        allUnmatched.push(id);
      }
    }
  }

  // filteredOut models are silently dropped (not matchable) — not added to
  // unmatched, to keep logs focused on models that COULD have matched.
  void filteredOut;

  return { matches: allMatches, unmatched: allUnmatched, error: batchError ?? undefined };
}

// ── Score resolution (merge pipeline) ────────────────────────────────────

/**
 * Resolve GDPval scores for a list of model refs by merging three sources.
 *
 * Precedence (first non-undefined wins; null means "deliberately excluded"):
 *   1. model-map.yaml (exact match, then wildcard)  — authoritative
 *   2. token-set fallback                            — cheap, deterministic
 *   3. LLM matches                                    — semantic safety net
 *
 * Returns a map: modelRef → score (number) | null (excluded/unknown).
 */
export function resolveModelScores(input: ResolveScoresInput): Record<string, number | null> {
  const { modelRefs, gdpvalScores, modelMap, modelMapWildcards, llmMatches = {} } = input;
  const result: Record<string, number | null> = {};

  for (const ref of modelRefs) {
    result[ref] = resolveOneScore(ref, gdpvalScores, modelMap, modelMapWildcards, llmMatches);
  }
  return result;
}

function resolveOneScore(
  ref: string,
  gdpvalScores: Record<string, number>,
  modelMap: Record<string, string | null>,
  modelMapWildcards: [string, string | null][],
  llmMatches: Record<string, string>
): number | null {
  // 1. model-map.yaml (authoritative). Try BOTH the full ref and the
  // provider-stripped form, because map keys may be either shape
  // (e.g. "zai-org/GLM-5-TEE" keeps its namespace; "glm-5-2" is bare).
  const stripped = stripProviderForMap(ref);
  for (const candidate of [ref, stripped]) {
    if (candidate in modelMap) {
      const mapped = modelMap[candidate];
      if (mapped === null) return null; // explicitly excluded
      return scoreForSlug(mapped, gdpvalScores);
    }
    for (const [prefix, slug] of modelMapWildcards) {
      if (candidate.startsWith(prefix)) {
        if (slug === null) return null; // explicitly excluded
        return scoreForSlug(slug, gdpvalScores);
      }
    }
  }

  // 2. token-set fallback
  const tokenScore = tokenSetScore(ref, gdpvalScores);
  if (tokenScore !== null) return tokenScore;

  // 3. LLM match
  const llmSlug = llmMatches[ref];
  if (llmSlug) {
    return scoreForSlug(llmSlug, gdpvalScores);
  }

  return null; // unknown
}

/**
 * Score lookup by slug: build token-set key for the slug and look it up.
 * Mirrors the existing lookupGdp index semantics (highest score across variants).
 */
function scoreForSlug(slug: string, gdpvalScores: Record<string, number>): number | null {
  // Direct slug hit first (most common case).
  if (slug in gdpvalScores) return gdpvalScores[slug];
  // Fall back to token-set match against all scores (handles slug variants).
  const key = [...baseTokens(slug)].sort().join('|');
  let best: number | null = null;
  for (const [s, score] of Object.entries(gdpvalScores)) {
    if ([...baseTokens(s)].sort().join('|') === key) {
      if (best === null || score > best) best = score;
    }
  }
  return best;
}

/**
 * Token-set fallback: match the model ref directly against all gdpval slugs.
 */
function tokenSetScore(ref: string, gdpvalScores: Record<string, number>): number | null {
  const key = [...baseTokens(ref)].sort().join('|');
  let best: number | null = null;
  for (const [slug, score] of Object.entries(gdpvalScores)) {
    if ([...baseTokens(slug)].sort().join('|') === key) {
      if (best === null || score > best) best = score;
    }
  }
  return best;
}

/**
 * Strip the provider prefix for model-map lookup.
 * Mirrors the index.ts stripProvider() semantics: only strip the first segment
 * if it looks like a known provider, otherwise keep the ref as-is.
 *
 * NOTE: model-map.yaml keys are model ids WITHOUT provider prefix
 * (e.g. "glm-5-2", "zai-org/GLM-5-TEE"), so we must match the key shape.
 * We strip a single leading "provider/" segment if present.
 */
function stripProviderForMap(ref: string): string {
  const i = ref.indexOf('/');
  if (i === -1) return ref;
  return ref.slice(i + 1);
}
