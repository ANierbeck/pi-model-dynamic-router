// src/providers.ts
// Provider-Definitionen für den pi-model-router

import type { ProviderDef } from "./types.js";

// ── Provider Discovery Map ────────────────────────────────────────────────

/**
 * Definitionen aller unterstützten Provider mit ihren Eigenschaften
 * für die automatische Erkennung und Konfiguration.
 */
export const PROVIDER_MAP: Record<string, ProviderDef> = {
  "anthropic": {
    envVar: "ANTHROPIC_API_KEY",
    authKey: "anthropic",
    passPatterns: ["api/claude", "api/anthropic"],
    billing: "subscription",
    modelsUrl: "https://api.anthropic.com/v1/models?limit=100",
    authHeader: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
    baseUrl: "https://api.anthropic.com",
    api: "anthropic"
  },
  
  "openai": {
    envVar: "OPENAI_API_KEY",
    authKey: "openai",
    passPatterns: ["api/openai"],
    billing: "pay_per_token",
    modelsUrl: "https://api.openai.com/v1/models",
    authHeader: (k) => ({ "Authorization": `Bearer ${k}` }),
    baseUrl: "https://api.openai.com",
    api: "openai-responses"
  },
  
  "google": {
    envVar: "GEMINI_API_KEY",
    authKey: "google",
    passPatterns: ["api/gemini", "api/google"],
    billing: "pay_per_token",
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    authHeader: (k) => ({ "x-goog-api-key": k }),
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: "gemini"
  },
  
  "openrouter": {
    envVar: "OPENROUTER_API_KEY",
    authKey: "openrouter",
    passPatterns: ["api/openrouter"],
    billing: "pay_per_token",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions"
  },
  
  "chutes": {
    envVar: "CHUTES_API_KEY",
    authKey: "chutes",
    passPatterns: ["api/chutes"],
    billing: "subscription",
    baseUrl: "https://llm.chutes.ai/v1",
    api: "openai-completions"
  },
  
  "mistral": {
    envVar: "MISTRAL_API_KEY",
    authKey: "mistral",
    passPatterns: ["api/mistral"],
    billing: "pay_per_token",
    modelsUrl: "https://api.mistral.ai/v1/models",
    authHeader: (k) => ({ "Authorization": `Bearer ${k}` }),
    baseUrl: "https://api.mistral.ai/v1",
    api: "openai-completions"
  },
  
  "groq": {
    envVar: "GROQ_API_KEY",
    authKey: "groq",
    passPatterns: ["api/groq"],
    billing: "pay_per_token",
    baseUrl: "https://api.groq.com/openai/v1",
    api: "openai-completions"
  },
  
  "cerebras": {
    envVar: "CEREBRAS_API_KEY",
    authKey: "cerebras",
    passPatterns: ["api/cerebras"],
    billing: "pay_per_token",
    baseUrl: "https://api.cerebras.ai/v1",
    api: "openai-completions"
  },
  
  "xai": {
    envVar: "XAI_API_KEY",
    authKey: "xai",
    passPatterns: ["api/xai"],
    billing: "pay_per_token",
    baseUrl: "https://api.x.ai/v1",
    api: "openai-completions"
  },
  
  "zai": {
    envVar: "ZAI_API_KEY",
    authKey: "zai",
    passPatterns: ["api/zai"],
    billing: "pay_per_token"
  },
  
  "huggingface": {
    envVar: "HF_TOKEN",
    authKey: "huggingface",
    passPatterns: ["api/huggingface", "api/hf"],
    billing: "pay_per_token"
  },
  
  "kimi-coding": {
    envVar: "KIMI_API_KEY",
    authKey: "kimi-coding",
    passPatterns: ["api/kimi"],
    billing: "pay_per_token"
  },
  
  "minimax": {
    envVar: "MINIMAX_API_KEY",
    authKey: "minimax",
    passPatterns: ["api/minimax"],
    billing: "pay_per_token"
  },
  
  "minimax-cn": {
    envVar: "MINIMAX_CN_API_KEY",
    authKey: "minimax-cn",
    passPatterns: [],
    billing: "pay_per_token"
  },
  
  "opencode": {
    envVar: "OPENCODE_API_KEY",
    authKey: "opencode",
    passPatterns: ["api/opencode"],
    billing: "pay_per_token"
  },
  
  "opencode-go": {
    envVar: "OPENCODE_API_KEY",
    authKey: "opencode-go",
    passPatterns: [],
    billing: "pay_per_token"
  },
  
  "vercel-ai-gateway": {
    envVar: "AI_GATEWAY_API_KEY",
    authKey: "vercel-ai-gateway",
    passPatterns: ["api/vercel"],
    billing: "pay_per_token"
  },
  
  "azure-openai": {
    envVar: "AZURE_OPENAI_API_KEY",
    authKey: "azure-openai-responses",
    passPatterns: ["api/azure"],
    billing: "pay_per_token"
  },
  
  "deepseek": {
    envVar: "DEEPSEEK_API_KEY",
    authKey: "deepseek",
    passPatterns: ["api/deepseek"],
    billing: "pay_per_token",
    modelsUrl: "https://api.deepseek.com/models",
    authHeader: (k) => ({ "Authorization": `Bearer ${k}` }),
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions"
  },
  
  "github-copilot": {
    authKey: "github-copilot",
    passPatterns: [],
    billing: "subscription"
  },
  
  "qwen-cli": {
    authKey: "qwen-cli",
    passPatterns: [],
    cliAuthFiles: [{ path: "~/.qwen/oauth_creds.json", tokenField: "access_token" }],
    billing: "subscription",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions"
  },
  
  "gemini-cli": {
    authKey: "gemini-cli",
    passPatterns: [],
    cliAuthFiles: [{ path: "~/.gemini/oauth_creds.json", tokenField: "access_token" }],
    billing: "subscription"
  },
  
  "antigravity": {
    authKey: "antigravity",
    passPatterns: [],
    billing: "subscription"
  },
  
  "ollama": {
    local: true,
    passPatterns: [],
    billing: "subscription"
  },
  
  "lm-studio": {
    local: true,
    passPatterns: [],
    billing: "subscription"
  },
};

/**
 * Liste der Provider, die nicht automatisch registriert werden sollen
 * (weil sie dedizierte Extensions oder eingebaute PI-Unterstützung haben)
 */
export const SKIP_REGISTRATION = new Set([
  "anthropic",
  "openai",
  "google",
  "qwen-cli",
  "gemini-cli",
  "ollama",
  "lm-studio",
  "antigravity"
]);

/**
 * Suffixes, die bei der Modell-ID-Normalisierung entfernt werden
 */
export const STRIP_SUFFIXES = [
  "-tee",
  ":free",
  ":api",
  "-instruct",
  "-thinking",
  "-chat",
  "-reasoning",
  "-fp8",
  "-preview"
];

/**
 * GDPval Parameter-Suffixes (werden bei der Basis-Modell-Extraktion entfernt)
 */
export const PARAM_SUFFIXES = [
  "-non-reasoning-low-effort",
  "-non-reasoning-high-effort",
  "-adaptive",
  "-non-reasoning",
  "-reasoning",
  "-thinking",
  "-low-effort",
  "-high-effort",
  "-max-effort"
];
