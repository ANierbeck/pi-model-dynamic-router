// src/capabilities.ts
// Single source of truth for normalizing real model capabilities from
// heterogeneous provider /v1/models (and Ollama /api/show + /api/tags)
// responses into one common ModelCapabilities shape.
//
// WHY (architecture problem B1): registerGroupModels previously registered
// EVERY model with hardcoded defaults — reasoning: true, input: ['text','image'],
// contextWindow: 200_000, maxTokens: 64_000. That was wrong per-model: glm-5-2
// can't do vision (caused the 422 "Image input is not enabled" compaction
// failure), Ollama models have wildly varying context windows (qwen3.5→262K,
// gemma2→8K). The provider responses DO carry real capabilities, but the scan
// threw them away. This module captures them per-provider and feeds them
// through to registerGroupModels.
//
// DESIGN (per Leitplanke 1 — generic, no setup-specific special cases):
//   - One normalizer function per provider response shape, dispatched by a
//     registry. Adding a new provider = adding one function + one registry
//     entry. No hardcoded model names, no "if mistral-zai then GLM".
//   - Unknown providers fall through to undefined capabilities → callers use
//     conservative defaults (see registerGroupModels).
//   - The registry is extensible from outside (registerCapabilityExtractor),
//     so provider-specific knowledge lives with the provider, not in a switch.

import type { ModelCapabilities } from './types.ts';

/** A raw parsed entry from a provider's models-list response (shape varies). */
type RawModelEntry = Record<string, unknown>;

/** Extracts ModelCapabilities from one raw model entry, or undefined if it can't. */
export type CapabilityExtractor = (entry: RawModelEntry) => ModelCapabilities | undefined;

const extractors = new Map<string, CapabilityExtractor>();

/**
 * Register a capability extractor for a provider.
 * @param provider the provider id (PROVIDER_MAP key, e.g. 'mistral', 'openrouter', 'ollama')
 * @param extractor called with the raw parsed model entry; returns the
 *   normalized capabilities, or undefined to defer to defaults.
 */
export function registerCapabilityExtractor(provider: string, extractor: CapabilityExtractor): void {
  extractors.set(provider, extractor);
}

/**
 * Extract capabilities for a model, given its provider and raw /v1/models entry.
 * Returns undefined if no extractor is registered for the provider (caller
 * falls back to conservative defaults) or the extractor declines.
 */
export function extractCapabilities(provider: string, raw: RawModelEntry): ModelCapabilities | undefined {
  const ex = extractors.get(provider);
  return ex ? ex(raw) : undefined;
}

// ── Built-in extractors for known provider response shapes ──────────────

/** Build a ModelCapabilities, omitting undefined fields (for exactOptionalPropertyTypes). */
function caps(vision?: boolean, reasoning?: boolean, contextWindow?: number, maxTokens?: number): ModelCapabilities {
  const out: ModelCapabilities = {};
  if (vision !== undefined) out.vision = vision;
  if (reasoning !== undefined) out.reasoning = reasoning;
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  return out;
}

/**
 * Mistral /v1/models shape: `capabilities.vision`, `capabilities.reasoning`,
 * `max_context_length`. (Mistral and mistral-zai share this shape — same
 * endpoint, same response format, only the auth key differs.)
 */
registerCapabilityExtractor('mistral', (e) => {
  const c = e.capabilities as Record<string, unknown> | undefined;
  return caps(
    c?.vision === true ? true : false,
    c?.reasoning === true ? true : false,
    typeof e.max_context_length === 'number' ? e.max_context_length : undefined,
  );
});
registerCapabilityExtractor('mistral-zai', (e) => {
  const c = e.capabilities as Record<string, unknown> | undefined;
  return caps(
    c?.vision === true ? true : false,
    c?.reasoning === true ? true : false,
    typeof e.max_context_length === 'number' ? e.max_context_length : undefined,
  );
});

/**
 * OpenRouter /v1/models shape: `architecture.input_modalities` (array incl.
 * 'text'/'image'), top-level `reasoning` object, `context_length`.
 */
registerCapabilityExtractor('openrouter', (e) => {
  const arch = e.architecture as Record<string, unknown> | undefined;
  const inputModalities = (arch?.input_modalities as unknown[] | undefined) ?? [];
  const reasoning = e.reasoning as Record<string, unknown> | undefined;
  return caps(
    inputModalities.some((m) => m === 'image') ? true : false,
    reasoning?.mandatory === true || reasoning?.default_enabled === true ? true : false,
    typeof e.context_length === 'number' ? e.context_length : undefined,
  );
});

/**
 * Ollama /api/show shape (preferred, richer than /api/tags): top-level
 * `capabilities` array (incl. 'vision', 'thinking', 'tools', 'completion')
 * and `model_info` with a `*.context_length` key (architecture-prefixed, e.g.
 * 'qwen3_5.context_length'). /api/tags alone doesn't carry context length;
 * the scan fetches /api/show per model to get it. Falls back to /api/tags'
 * `details.families` (clip/mllama) for vision if /api/show is unavailable.
 */
registerCapabilityExtractor('ollama', (e) => {
  const capsArr = (e.capabilities as unknown[] | undefined) ?? [];
  const visionFromCaps = capsArr.some((c) => c === 'vision');
  const reasoningFromCaps = capsArr.some((c) => c === 'thinking');
  // If /api/show data, prefer it; otherwise fall back to /api/tags families.
  const details = e.details as Record<string, unknown> | undefined;
  const families = (details?.families as unknown[] | undefined) ?? [];
  const vision = visionFromCaps || families.some((f) => f === 'clip' || f === 'mllama');
  // Context length from model_info.*.context_length (architecture-prefixed key).
  const modelInfo = (e.model_info as Record<string, unknown> | undefined) ?? {};
  const ctxKey = Object.keys(modelInfo).find((k) => k.endsWith('.context_length'));
  const contextWindow =
    ctxKey && typeof modelInfo[ctxKey] === 'number' ? (modelInfo[ctxKey] as number) : undefined;
  return caps(
    vision ? true : false,
    reasoningFromCaps ? true : false,
    contextWindow,
  );
});
