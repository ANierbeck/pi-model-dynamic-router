// src/providers.ts
// Provider definitions for the pi-model-router.
//
// ADR-0022: this map no longer carries any credential plumbing (env-var
// names, auth-store keys, pass-store patterns, CLI auth files, catalog
// endpoints, auth headers). Pi owns credential resolution; the remaining
// fields describe how a provider is TALKED TO (baseUrl/api for the
// explicitly-configured free-model registration), how it is BILLED, and
// pricing aliases.

import type { ProviderDef } from './types.ts';

// ── Provider Discovery Map ────────────────────────────────────────────────

/**
 * Definitions of all supported providers with their properties
 * for automatic discovery and configuration.
 */
export const PROVIDER_MAP: Record<string, ProviderDef> = {
  anthropic: {
    billing: 'subscription',
    baseUrl: 'https://api.anthropic.com',
    api: 'anthropic',
  },

  openai: {
    billing: 'pay_per_token',
    baseUrl: 'https://api.openai.com',
    api: 'openai-responses',
  },

  google: {
    billing: 'pay_per_token',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    api: 'gemini',
  },

  openrouter: {
    billing: 'pay_per_token',
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai-completions',
  },

  chutes: {
    billing: 'subscription',
    baseUrl: 'https://llm.chutes.ai/v1',
    api: 'openai-completions',
  },

  mistral: {
    billing: 'pay_per_token',
    baseUrl: 'https://api.mistral.ai/v1',
    api: 'openai-completions',
  },

  // mistral-zai: Zhipu/Z-AI GLM models hosted on Mistral "Le Platform".
  // Same OpenAI-compatible endpoint, separate API key in Pi's auth store.
  // Without this entry stripProvider() fails to recognise the
  // 'mistral-zai/' prefix, so GDPval lookup breaks.
  'mistral-zai': {
    billing: 'pay_per_token',
    baseUrl: 'https://api.mistral.ai/v1',
    api: 'openai-completions',
    // Same account/API as `mistral` (see comment above) — Pi's own model
    // catalog never registers this router-internal key, so it has no
    // pricing of its own to find. Borrow mistral's registry pricing.
    pricingAlias: 'mistral',
    // The Z-AI GLM models are namespaced 'zai-<model>' on this platform; the
    // upstream (and its GDPval slug) is just '<model>'.
    modelIdVendorPrefix: 'zai-',
  },

  groq: {
    billing: 'pay_per_token',
    baseUrl: 'https://api.groq.com/openai/v1',
    api: 'openai-completions',
  },

  cerebras: {
    billing: 'pay_per_token',
    baseUrl: 'https://api.cerebras.ai/v1',
    api: 'openai-completions',
  },

  xai: {
    billing: 'pay_per_token',
    baseUrl: 'https://api.x.ai/v1',
    api: 'openai-completions',
  },

  zai: {
    billing: 'pay_per_token',
  },

  huggingface: {
    billing: 'pay_per_token',
  },

  'kimi-coding': {
    billing: 'pay_per_token',
  },

  minimax: {
    billing: 'pay_per_token',
  },

  'minimax-cn': {
    billing: 'pay_per_token',
  },

  opencode: {
    billing: 'pay_per_token',
  },

  'opencode-go': {
    billing: 'pay_per_token',
  },

  'vercel-ai-gateway': {
    billing: 'pay_per_token',
  },

  'azure-openai': {
    billing: 'pay_per_token',
  },

  deepseek: {
    billing: 'pay_per_token',
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-completions',
  },

  'github-copilot': {
    billing: 'subscription',
  },

  'qwen-cli': {
    billing: 'subscription',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api: 'openai-completions',
  },

  'gemini-cli': {
    billing: 'subscription',
  },

  antigravity: {
    billing: 'subscription',
  },

  ollama: {
    local: true,
    billing: 'subscription',
  },

  'lm-studio': {
    local: true,
    billing: 'subscription',
  },
};

/**
 * Pi's builtin provider ids (pi 0.99.1 catalog, sourced from
 * core/model-resolver.js `defaultModelPerProvider` plus the provider catalog
 * in models.json). registerGroupProviders must NEVER register a virtual
 * group provider under one of these ids: pi.registerProvider REPLACES the
 * provider's `models` array wholesale (AGENTS.md §6 / Ü1), so a user-defined
 * model group named e.g. "openai" would wipe pi's entire openai catalog.
 *
 * This list is a conservative LOAD-TIME guard — pi's extension API exposes
 * no registry query while extensions load. It may lag behind newer pi
 * versions (a new builtin id would fall through); the session_start
 * re-register additionally checks getRegisteredProviderIds() for ids the
 * router itself did NOT register. Keep in sync when bumping the pi version.
 */
export const PI_BUILTIN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'amazon-bedrock',
  'ant-ling',
  'anthropic',
  'azure-openai-responses',
  'baseten',
  'cerebras',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'deepseek',
  'fireworks',
  'github-copilot',
  'google',
  'google-vertex',
  'groq',
  'huggingface',
  'kimi-coding',
  'meta',
  'minimax',
  'minimax-cn',
  'mistral',
  'moonshotai',
  'moonshotai-cn',
  'nvidia',
  'openai',
  'openai-codex',
  'opencode',
  'opencode-go',
  'openrouter',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'radius',
  'together',
  'vercel-ai-gateway',
  'xiaomi',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'xai',
  'zai',
  'zai-coding-cn',
]);

/**
 * Suffixes stripped during model-id normalization
 */
export const STRIP_SUFFIXES = [
  '-tee',
  ':free',
  ':api',
  '-instruct',
  '-thinking',
  '-chat',
  '-reasoning',
  '-fp8',
  '-preview',
];

/**
 * GDPval parameter suffixes (stripped during base-model extraction)
 */
export const PARAM_SUFFIXES = [
  '-non-reasoning-low-effort',
  '-non-reasoning-high-effort',
  '-adaptive',
  '-non-reasoning',
  '-reasoning',
  '-thinking',
  '-low-effort',
  '-high-effort',
  '-max-effort',
];
