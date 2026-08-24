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

// ── Prompt building ───────────────────────────────────────────────────────

import { candidateSlugs } from './slug-matcher.ts';

/**
 * Build a PER-MODEL prompt where each model only sees its top-K candidate slugs
 * (pre-filtered by the algorithmic slug-matcher). This dramatically shortens
 * the prompt and makes the LLM's job a VERIFICATION task, not a search.
 *
 * If a model has no candidates (unknown family), it's included in a separate
 * "no candidates" section so the LLM knows it exists but can't match it.
 */
export function buildMatchPromptWithCandidates(
  modelIds: string[],
  gdpvalEntries: GdpvalEntry[],
  maxKCandidates: number = 5
): string {
  const gdpvalMap = new Map(gdpvalEntries.map(g => [g.slug, g]));
  const allSlugs = gdpvalEntries.map(g => g.slug);

  // For each model, get its top-K candidates
  const perModel: { modelId: string; candidates: GdpvalEntry[] }[] = [];
  const noCandidates: string[] = [];

  for (const id of modelIds) {
    const slugs = candidateSlugs(id, allSlugs, maxKCandidates);
    if (slugs.length === 0) {
      noCandidates.push(id);
    } else {
      perModel.push({
        modelId: id,
        candidates: slugs
          .map(s => gdpvalMap.get(s))
          .filter((g): g is GdpvalEntry => g !== undefined),
      });
    }
  }

  // Build the per-model block
  const perModelBlock = perModel.map(({ modelId, candidates }) => {
    const cands = candidates
      .map(g => `  - slug: "${g.slug}"  (display: "${g.label}", score: ${g.score})`)
      .join('\n');
    return `- Model ID: "${modelId}"\n  Candidates:\n${cands}`;
  }).join('\n\n');

  const noCandidatesBlock = noCandidates.length > 0
    ? `\n\n# Models with no algorithmic candidates ( OMIT these — no match possible)\n${noCandidates.map(m => `- ${m}`).join('\n')}`
    : '';

  return `You are a model-name matcher. For each model ID, VERIFY which candidate slug refers to the SAME model, or OMIT if unsure.

# Models and their pre-filtered candidates
${perModelBlock || '(no models with candidates)'}${noCandidatesBlock}

# Rules
- Output ONLY a JSON object mapping model ID → slug.
- Use the EXACT model ID string from above as the key.
- Use the EXACT slug string from the candidates as the value.
- Match the MODEL FAMILY and VENDOR: never match a model to a slug from a
  different vendor (mistral → claude, qwen → gpt, etc.), even if it appears
  among the candidates.
- Match the VERSION NUMBER precisely: "glm-5-2" ≠ "glm-5-3" ≠ "glm-4".
  Different version numbers mean different models.
  Exception: date-versioned models (YYMM like 2604, 2505, 2508) map to their
  named version (e.g. mistral-medium-2604 = mistral-medium-3-5, April 2026
  release). Use your knowledge of model release history for other date
  suffixes among the candidates.
- Match MODEL SIZE/TIER: a 3b/7b/8b model must NOT match a medium/large slug.
- If unsure, OMIT the model from the output (don't guess).
- Do NOT invent slugs. Do NOT use markdown fences.

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
 * precision) are conveyed to the LLM via buildMatchPromptWithCandidates().
 * This guard catches cross-family hallucinations the LLM might still produce.
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
    const prompt = buildMatchPromptWithCandidates(batch, gdpvalEntries);

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

// NOTE (A2, 2026-08-24): this module used to also export a second, parallel
// GDPval score-resolution pipeline (resolveModelScores/resolveOneScore/
// scoreForSlug/tokenSetScore) that merged model-map.yaml -> token-fallback ->
// LLM matches on its own. It was dead code - index.ts never called it, only
// tests did - and it had DRIFTED from the real production pipeline
// (src/metrics.ts resolveSlug/lookupGdp): stage order was reversed (LLM
// before token-fallback in metrics.ts vs. after in the dead code) and its
// token-set matcher was a weaker, separate implementation than
// src/slug-matcher.ts's matchSlug. Removed to leave exactly ONE resolution
// pipeline: src/metrics.ts resolveSlug() (see its docstring for the
// authoritative stage order). The LLM-matching orchestration in this file
// (matchModelsWithLLMBatched et al.) is unaffected - it still feeds
// resolveSlug's Stage 1 via setLlmMatches().
