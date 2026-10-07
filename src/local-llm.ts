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

import type { ProviderDef, Config, Cache, AvailableModel } from './types.ts';
import { isCompletionCapable, parameterSizeB } from './classifier-local-probe.ts';

/**
 * Size budget (billions of parameters) for the model-name matcher's local
 * model: beyond this a cold start can exceed the call timeout. A heuristic
 * about hardware and latency, not about any model.
 */
const MATCHER_MAX_PARAMS_B = 14;

// ── Types ─────────────────────────────────────────────────────────────────

export interface LocalLlmDeps {
  providers: Record<string, ProviderDef>;
  cache: Cache;
  cfg: Config;
  timeoutMs?: number;
  /**
   * Pi-side API key resolution (ADR-0022): wired to
   * modelRegistry.getApiKeyForProvider in index.ts. The router never
   * resolves keys itself; a provider whose key Pi cannot resolve is
   * skipped by the cloud fallback.
   */
  resolveApiKey: (provider: string) => Promise<string | null>;
}

interface ResolvedLocalProvider {
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
 * - RANK candidates by size, derived from the scan (no model names, ADR-0025):
 *   the largest model within the matcher size budget wins, because the
 *   matcher prompt is large (100+ models) and a very large model may time out.
 * - Return the highest-ranked match (deterministic given cache order).
 *
 * Returns null when no local provider has any discovered model.
 */
export function resolveLocalProvider(deps: LocalLlmDeps): ResolvedLocalProvider | null {
  const { providers, cache } = deps;
  const available = cache.available_models ?? [];
  if (available.length === 0) return null;

  // Collect candidate (providerId, modelId) pairs from local providers.
  const candidates: { providerId: string; modelId: string; model: AvailableModel }[] = [];
  for (const [provId, def] of Object.entries(providers)) {
    if (!def.local) continue;
    for (const m of available) {
      if (m.provider === provId) {
        candidates.push({ providerId: provId, modelId: m.id, model: m });
      }
    }
  }
  if (candidates.length === 0) return null;

  // Rank by suitability for the model-name matching task, DERIVED from what
  // the scan reported (ADR-0025 — no model names). The matcher needs a model
  // that reliably produces valid JSON and understands semantic name
  // similarity, but its prompt is large (100+ models) and must answer within
  // the call timeout, so: the LARGEST model that fits the size budget wins;
  // models over the budget come after (smallest first); size-unknown models
  // last; name as the stable tiebreak. Embedding-only / non-completion
  // models are never candidates.
  const sized = candidates
    .filter((c) => isCompletionCapable(c.model))
    .map((c) => ({ ...c, size: parameterSizeB(c.model) }));
  if (sized.length === 0) return null;
  const tier = (size: number | undefined) =>
    size === undefined ? 2 : size <= MATCHER_MAX_PARAMS_B ? 0 : 1;
  const chosen = [...sized].sort((a, b) => {
    const ta = tier(a.size);
    const tb = tier(b.size);
    if (ta !== tb) return ta - tb;
    if (a.size !== undefined && b.size !== undefined && a.size !== b.size) {
      return ta === 0 ? b.size - a.size : a.size - b.size;
    }
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
  const { cfg, providers, resolveApiKey, timeoutMs = 30_000 } = deps;
  const freeModels = await collectFreeCloudModels(cfg, providers, resolveApiKey);
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
 * but also resolves the provider's baseUrl so we can call them, and asks Pi
 * for each provider's API key (ADR-0022). A provider whose key Pi cannot
 * resolve is skipped entirely — an unusable key would otherwise produce
 * free-model entries that always fail auth and crowd out working fallbacks.
 */
async function collectFreeCloudModels(
  cfg: Config,
  providers: Record<string, ProviderDef>,
  resolveApiKey: (provider: string) => Promise<string | null>
): Promise<FreeCloudModel[]> {
  const result: FreeCloudModel[] = [];
  for (const [provId, provConfig] of Object.entries(cfg.providers ?? {})) {
    const freeModels = provConfig.free_models;
    if (!freeModels || freeModels.length === 0) continue;
    const def = providers[provId];
    if (!def || !def.baseUrl || def.api !== 'openai-completions') continue;
    const apiKey = await resolveApiKey(provId);
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
