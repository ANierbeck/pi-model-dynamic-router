// src/ollama-context.ts
// Resolve Ollama num_ctx (context window) for model registration.
//
// NOT merged with ollama-gdpval.ts / ollama-utils.ts (F1 evaluation): this
// module derives providerOptions from scan-captured capabilities, a
// distinct concern from GDPval scoring math and the live Ollama HTTP
// client. Kept separate — no shared state or call graph to consolidate.
//
// WHY (architecture problem B1, setup-independent): Ollama defaults to
// num_ctx=32768 when the request omits options.num_ctx. Many models support
// far more (qwen3.5→262K, gemma4→131K), so prompts >32K get truncated
// ("stop processing: n_tokens = 32767, truncated = 1") unless num_ctx is
// sent. The router registers Ollama (only when Pi doesn't know it — see Ü1)
// with providerOptions.num_ctx per model.
//
// SOURCE: the REAL context length is queried live from Ollama's /api/show
// endpoint (model_info.*.context_length) by the scan, and stored in
// cache.available_models[].capabilities.contextWindow. This module reads
// that. No hardcoded model-family table, no dependency on any specific
// Ollama extension (gsd-pi or otherwise) — works for every user.
//
// FALLBACK: if the scan couldn't get /api/show for a model (endpoint down,
// old Ollama version), a conservative default (32768) is used. We deliberately
// do NOT keep a curated per-family table here — that would drift from the
// real Ollama values and re-introduce the setup-specificity we removed.
// /api/show is the single source of truth; absent data = conservative
// default, never a guess.

/** Conservative fallback when /api/show didn't yield a context length. */
const DEFAULT_CONTEXT_WINDOW = 32768;
const DEFAULT_MAX_TOKENS = 8192;

export interface OllamaContextOptions {
  contextWindow: number;
  num_ctx: number;
  maxTokens: number;
}

/**
 * Resolve Ollama context options for a model from its REAL capabilities
 * (captured live from /api/show during the scan). Falls back to the
 * conservative default when the scan didn't get a value.
 *
 * @param capabilities the model's capabilities from cache.available_models
 *   (vision/reasoning/contextWindow/maxTokens), or undefined if the scan
 *   couldn't determine them.
 */
export function getOllamaContext(
  capabilities: { contextWindow?: number; maxTokens?: number } | undefined
): OllamaContextOptions {
  const contextWindow = capabilities?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return {
    contextWindow,
    num_ctx: contextWindow, // num_ctx mirrors contextWindow: Ollama uses it as the prompt window size.
    maxTokens: capabilities?.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

/**
 * Build the models array for pi.registerProvider('ollama', ...) with
 * providerOptions.num_ctx set per model from its real capabilities (or the
 * conservative default). Used when Pi does NOT yet know Ollama — the router
 * registers it with real num_ctx values so prompts >32K don't truncate.
 *
 * @param ollamaModels the discovered Ollama models, each with its capabilities
 *   from the scan (may be undefined if /api/show failed for that model).
 */
export function buildOllamaProviderModels(
  ollamaModels: { id: string; capabilities?: { contextWindow?: number; maxTokens?: number } }[]
): Array<{
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  providerOptions: { num_ctx: number };
}> {
  return ollamaModels.map((m) => {
    const caps = getOllamaContext(m.capabilities);
    return {
      id: m.id,
      name: m.id,
      reasoning: false, // conservative — Ollama /api/show capabilities handled separately if needed
      input: ['text'], // conservative — vision is determined per-model by the scan's capabilities
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: caps.contextWindow,
      maxTokens: caps.maxTokens,
      providerOptions: { num_ctx: caps.num_ctx },
    };
  });
}
