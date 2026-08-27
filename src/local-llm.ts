// src/local-llm.ts
// Provider-agnostic local LLM caller with free-cloud fallback.
//
// The router needs an LLM for two low-frequency tasks (prompt classification
// and, now, model-name matching). Historically both hard-coded Ollama on
// localhost:11434. This module generalizes that:
//
//   1. Discover the local provider generically: whichever PROVIDER_MAP entry
//      marked `local: true` has discovered models (Ollama OR LM Studio OR a
//      future local provider). Use its endpoint.
//   2. Call it using the OpenAI chat/completions format (both Ollama and
//      LM Studio speak this on /v1/chat/completions; Ollama also accepts its
//      native /api/generate but /v1/chat/completions is the common ground).
//   3. On local failure (or no local provider), fall back to the configured
//      free OpenRouter cloud models — the original router's safety net.
//   4. If everything fails, throw a clear error so callers can fail-open.
//
// All dependencies (PROVIDER_MAP, cache, config) are injected so the module
// is fully unit-testable with a mocked fetch and no network.

import type { ProviderDef, Config, Cache } from './types.ts';
import { resolveKeyRef, loadAuthFile } from './discovery.ts';

// ── Types ─────────────────────────────────────────────────────────────────

export interface LocalLlmDeps {
  providers: Record<string, ProviderDef>;
  cache: Cache;
  cfg: Config;
  timeoutMs?: number;
}

export interface ResolvedLocalProvider {
  providerId: string;
  /** Model id to pass in the `model` field of the chat request. */
  modelId: string;
  /** Base URL for the OpenAI-compatible endpoint. */
  baseUrl: string;
}

// ── Local provider resolution ────────────────────────────────────────────

/**
 * Resolve which local provider + model to use for LLM tasks.
 *
 * Strategy:
 * - Iterate providers that are marked `local: true` in PROVIDER_MAP.
 * - For each, find models in cache.available_models whose `provider` matches.
 * - RANK candidates by suitability for short, structured tasks (model-name
 *   matching, classification): prefer SMALL fast models over large slow ones,
 *   because the matcher prompt can be large (100+ models) and a 12B model
 *   may time out. Prefer gemma2:2b > gemma(3-4b) > gemma(others) > llama3.1 > others.
 * - Return the highest-ranked match (deterministic given cache order).
 *
 * Returns null when no local provider has any discovered model.
 */
export function resolveLocalProvider(deps: LocalLlmDeps): ResolvedLocalProvider | null {
  const { providers, cache } = deps;
  const available = cache.available_models ?? [];
  if (available.length === 0) return null;

  // Collect candidate (providerId, modelId) pairs from local providers.
  const candidates: { providerId: string; modelId: string }[] = [];
  for (const [provId, def] of Object.entries(providers)) {
    if (!def.local) continue;
    for (const m of available) {
      if (m.provider === provId) {
        candidates.push({ providerId: provId, modelId: m.id });
      }
    }
  }
  if (candidates.length === 0) return null;

  // Rank by suitability for structured-output matching tasks.
  // The matcher needs a model that reliably produces valid JSON and
  // understands semantic model-name similarity, BUT must also respond
  // within ~45s. Very large models (35B+, 20GB+) may time out.
  // Lower rank = better.
  const FAMILY_RANK: { regex: RegExp; rank: number }[] = [
    { regex: /gemma4:12b|gemma-4[.-]12b/i, rank: 0 }, // 12B — best balance of speed + capability
    { regex: /qwen3[.:]?5|qwen-3[.-]5/i, rank: 1 }, // 6GB — fast + capable
    { regex: /gemma4:latest|gemma-4(?!.*12b)/i, rank: 2 }, // 9GB gemma4
    { regex: /mistral-nemo|llama3[.:]1|llama-3\.1/i, rank: 3 },
    { regex: /qwen3[.:]6|qwen-3[.-]6/i, rank: 4 }, // 35B — capable but SLOW, may time out
    { regex: /gemma2:9b|gemma-2:9b/i, rank: 5 },
    { regex: /gemma4|llama|qwen|mistral|glm|phi|deepseek/i, rank: 6 },
    { regex: /gemma2:2b|gemma-2:2b/i, rank: 9 }, // TOO WEAK for matching — last resort only
    { regex: /.*/, rank: 7 }, // anything else
  ];
  function rankOf(modelId: string): number {
    for (const { regex, rank } of FAMILY_RANK) if (regex.test(modelId)) return rank;
    return 5;
  }

  const chosen = [...candidates].sort((a, b) => {
    const ra = rankOf(a.modelId);
    const rb = rankOf(b.modelId);
    if (ra !== rb) return ra - rb;
    return a.modelId.localeCompare(b.modelId);
  })[0];

  const def = providers[chosen.providerId];
  const baseUrl = localBaseUrl(def, chosen.providerId);

  return {
    providerId: chosen.providerId,
    modelId: chosen.modelId,
    baseUrl,
  };
}

/**
 * Determine the OpenAI-compatible base URL for a local provider.
 * Ollama listens on :11434; LM Studio on :1234 by default. Both accept
 * /v1/chat/completions (Ollama also accepts /api/chat). We normalize to the
 * OpenAI path so one code path serves both.
 */
function localBaseUrl(def: ProviderDef, provId: string): string {
  if (def.baseUrl) return def.baseUrl;
  switch (provId) {
    case 'ollama':
      return 'http://localhost:11434/v1';
    case 'lm-studio':
      return 'http://localhost:1234/v1';
    default:
      return 'http://localhost:11434/v1';
  }
}

// ── Local LLM call (OpenAI chat/completions format) ───────────────────────

/**
 * Call the local LLM with a prompt, returning its text response.
 *
 * Falls back to free OpenRouter cloud models if no local provider is available
 * or the local call fails.
 *
 * @throws Error("no LLM available...") when both local and cloud fail.
 */
export async function callLocalLlm(prompt: string, deps: LocalLlmDeps): Promise<string> {
  const { timeoutMs = 30_000 } = deps;
  const local = resolveLocalProvider(deps);

  if (local) {
    try {
      const content = await callOpenAiChat({
        baseUrl: local.baseUrl,
        model: local.modelId,
        prompt,
        apiKey: null, // local providers need no auth
        timeoutMs,
      });
      return content;
    } catch (err) {
      // Fall through to cloud fallback.
      // (Intentionally swallowed; cloud fallback is the safety net.)
    }
  }

  // Cloud fallback: free OpenRouter models.
  const cloudResult = await callCloudFallback(prompt, deps);
  if (cloudResult !== null) return cloudResult;

  throw new Error(
    `no LLM available: local provider ${local ? `(${local.providerId}) failed` : 'not available'} and no free cloud model succeeded`
  );
}

// ── OpenAI-compatible chat call (shared by local + cloud) ─────────────────

interface OpenAiChatArgs {
  baseUrl: string;
  model: string;
  prompt: string;
  apiKey: string | null;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
}

async function callOpenAiChat(args: OpenAiChatArgs): Promise<string> {
  const { baseUrl, model, prompt, apiKey, timeoutMs, extraHeaders } = args;
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(extraHeaders ?? {}),
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    temperature: 0,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`LLM HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned no content');
  return content;
}

// ── Cloud fallback (free OpenRouter models) ───────────────────────────────

/**
 * Try each configured free cloud model in order until one succeeds.
 * Returns the model's text response, or null if all fail.
 */
async function callCloudFallback(
  prompt: string,
  deps: LocalLlmDeps
): Promise<string | null> {
  const { cfg, providers, timeoutMs = 30_000 } = deps;
  const freeModels = collectFreeCloudModels(cfg, providers);
  if (freeModels.length === 0) return null;

  for (const m of freeModels) {
    try {
      const content = await callOpenAiChat({
        baseUrl: m.baseUrl,
        model: m.modelId,
        prompt,
        apiKey: m.apiKey,
        timeoutMs,
      });
      return content;
    } catch {
      // try next free model
    }
  }
  return null;
}

interface FreeCloudModel {
  baseUrl: string;
  modelId: string;
  apiKey: string | null;
}

/**
 * Collect free cloud models from config. Mirrors DiscoveryManager.getFreeModels()
 * but also resolves the provider's baseUrl/apiKey/headers so we can call them.
 */
function collectFreeCloudModels(
  cfg: Config,
  providers: Record<string, ProviderDef>
): FreeCloudModel[] {
  const result: FreeCloudModel[] = [];
  for (const [provId, provConfig] of Object.entries(cfg.providers ?? {})) {
    const freeModels = provConfig.free_models;
    if (!freeModels || freeModels.length === 0) continue;
    const def = providers[provId];
    if (!def || !def.baseUrl || def.api !== 'openai-completions') continue;
    const keys = provConfig.keys ?? [];
    if (keys.length === 0) continue;
    // Skip the provider entirely when its key cannot be resolved — an
    // unusable key would otherwise produce free-model entries that always
    // fail auth and crowd out working fallbacks.
    const apiKey = resolveKeyValue(keys[0].key);
    if (!apiKey) continue;

    for (const freeRef of freeModels) {
      // free_models entries may be "provider/modelId" or bare "modelId".
      const modelId = freeRef.startsWith(`${provId}/`)
        ? freeRef.slice(provId.length + 1)
        : freeRef;
      result.push({
        baseUrl: def.baseUrl,
        modelId,
        apiKey,
      });
    }
  }
  return result;
}

/**
 * Resolve a key value that may be a pass-store reference.
 * Mirrors DiscoveryManager.resolveKeyValue() but kept local to avoid a
 * circular import. For direct keys, returns as-is.
 *
 * Returns null when the key is a marker this function cannot resolve. The
 * previous version returned such markers verbatim, so a pass-managed key was
 * sent as `Authorization: Bearer !pass show ...` -- the request failed auth
 * and was silently swallowed per-model, quietly disabling the cloud fallback
 * for anyone using pass. Returning null lets the caller skip the provider
 * instead of issuing a request that cannot succeed.
 *
 * Delegates to the shared pure `resolveKeyRef` (from discovery.ts) so there
 * is exactly one copy of the marker-resolution logic across the codebase;
 * the old local copy had drifted and missed the __auth_json__ marker, which
 * silently disabled this free-model cloud fallback for auth.json-only
 * providers after auth.json keys stopped being stored raw.
 */
function resolveKeyValue(key: string): string | null {
  return resolveKeyRef(key, loadAuthFile());
}
