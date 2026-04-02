/**
 * pi-model-router — Passive model group routing for pi
 *
 * Routes group names (strategic/tactical/operational/scout) to concrete models.
 * Balances intelligence, cost, and availability via:
 *   - GDPval-ranked selection pipelines
 *   - Subscription cost discount (sunk cost preference)
 *   - Exponential backoff on 429 + permanent costMux per provider
 *   - Passive throughput/latency tracking from observed turns
 */
import type { AssistantMessage, AssistantMessageEvent, Model, Context, SimpleStreamOptions, AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { streamSimple as piStreamSimple, createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { truncateToWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

// ── Types ──────────────────────────────────────────────────────────────────

interface Metrics { gdpval: number; throughput_tps: number; avg_latency_ms: number; cost_per_m: number; last_updated: number; }
interface RateLimit { cooldown_until: number; backoff_ms: number; hits: number; }
interface PipeStep { method: string; top_k?: number; }
interface Group { description?: string; method: string; top_k?: number; pipeline?: PipeStep[]; models?: string[]; filter_free?: boolean; min_gdpval_pct?: number; min_gdpval?: number; }
interface ProviderKey { key: string; label?: string; }
interface ProviderConfig { billing: string; monthly_cost_usd?: number; keys?: ProviderKey[]; }
interface Config {
  providers?: Record<string, ProviderConfig>;
  model_groups: Record<string, Group>;
  model_metrics: Record<string, Partial<Metrics>>;
  gdpval_builtin?: Record<string, number>;
}
interface Cache {
  gdpval_scores?: Record<string, number>; gdpval_scraped?: boolean;
  models_cached?: string; available_models?: { id: string; provider: string; cost_per_m: number }[];
  benchmarks?: Record<string, number>;
  cost_mux?: Record<string, number>; cost_mux_last_bump?: Record<string, string>;
  exhausted_keys?: Record<string, number>; // "provider:keyIdx" → exhausted_until timestamp
  openrouter_pricing?: Record<string, { input: number; output: number }>; // provider/modelId ref → $/1M
  usage_log?: { ref: string; tokens: number; ts: number }[]; // token usage history
}

// ── Constants (loaded from router-defaults.yaml) ───────────────────────────

interface Defaults {
  gdpval_url: string;
  backoff_minutes: number[];
  soft_backoff_ms: number[];
  cost_mux_at_hit: number;
  sub_discount: number;
  models_ttl_ms: number;
  max_stream_retries: number;
  empty_response_timeout_ms: number;
  strip_suffixes: string[];
}

function loadDefaults(extDir: string): Defaults {
  const yamlPath = path.join(extDir, "router-defaults.yaml");
  return YAML.parse(fs.readFileSync(yamlPath, "utf-8")) as Defaults;
}

const _defaults = loadDefaults(path.dirname(fileURLToPath(import.meta.url)));
const BACKOFF = _defaults.backoff_minutes.map(m => m * 60_000);
const SOFT_BACKOFF = _defaults.soft_backoff_ms;
const COST_MUX_AT_HIT = _defaults.cost_mux_at_hit;
const SUB_DISCOUNT = _defaults.sub_discount;
const MODELS_TTL = _defaults.models_ttl_ms;
const MAX_STREAM_RETRIES = _defaults.max_stream_retries;
const EMPTY_RESPONSE_TIMEOUT_MS = _defaults.empty_response_timeout_ms;
const GDPVAL_URL = _defaults.gdpval_url;

// ── Provider Discovery Map ─────────────────────────────────────────────

interface ProviderDef {
  envVar?: string;        // e.g. "ANTHROPIC_API_KEY"
  authKey?: string;       // key in ~/.pi/agent/auth.json
  passPatterns?: string[]; // glob-ish prefixes to match in `pass ls`
  cliAuthFiles?: { path: string; tokenField: string }[]; // CLI tool auth files (e.g. ~/.qwen/oauth_creds.json)
  local?: boolean;        // ollama/lm-studio — no key needed
  billing?: string;       // default billing type
  modelsUrl?: string;     // API endpoint for model discovery (e.g. /v1/models)
  authHeader?: (key: string) => Record<string, string>; // how to authenticate
  baseUrl?: string;       // API base URL for pi provider registration
  api?: string;           // pi API type (e.g. "anthropic", "openai-responses", "qwen")
}

const PROVIDER_MAP: Record<string, ProviderDef> = {
  "anthropic":           { envVar: "ANTHROPIC_API_KEY",    authKey: "anthropic",             passPatterns: ["api/claude", "api/anthropic"],   billing: "subscription", modelsUrl: "https://api.anthropic.com/v1/models?limit=100", authHeader: k => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }), baseUrl: "https://api.anthropic.com", api: "anthropic" },
  "openai":              { envVar: "OPENAI_API_KEY",       authKey: "openai",                passPatterns: ["api/openai"],                    billing: "pay_per_token", modelsUrl: "https://api.openai.com/v1/models", authHeader: k => ({ "Authorization": `Bearer ${k}` }), baseUrl: "https://api.openai.com", api: "openai-responses" },
  "google":              { envVar: "GEMINI_API_KEY",       authKey: "google",                passPatterns: ["api/gemini", "api/google"],      billing: "pay_per_token", modelsUrl: "https://generativelanguage.googleapis.com/v1beta/models", authHeader: k => ({ "x-goog-api-key": k }), baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "gemini" },
  "openrouter":          { envVar: "OPENROUTER_API_KEY",   authKey: "openrouter",            passPatterns: ["api/openrouter"],                billing: "pay_per_token", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
  "chutes":              { envVar: "CHUTES_API_KEY",       authKey: "chutes",                passPatterns: ["api/chutes"],                    billing: "subscription", baseUrl: "https://llm.chutes.ai/v1", api: "openai-completions" },
  "mistral":             { envVar: "MISTRAL_API_KEY",      authKey: "mistral",               passPatterns: ["api/mistral"],                   billing: "pay_per_token", modelsUrl: "https://api.mistral.ai/v1/models", authHeader: k => ({ "Authorization": `Bearer ${k}` }), baseUrl: "https://api.mistral.ai/v1", api: "openai-completions" },
  "groq":                { envVar: "GROQ_API_KEY",         authKey: "groq",                  passPatterns: ["api/groq"],                      billing: "pay_per_token", baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions" },
  "cerebras":            { envVar: "CEREBRAS_API_KEY",     authKey: "cerebras",              passPatterns: ["api/cerebras"],                  billing: "pay_per_token", baseUrl: "https://api.cerebras.ai/v1", api: "openai-completions" },
  "xai":                 { envVar: "XAI_API_KEY",          authKey: "xai",                   passPatterns: ["api/xai"],                       billing: "pay_per_token", baseUrl: "https://api.x.ai/v1", api: "openai-completions" },
  "zai":                 { envVar: "ZAI_API_KEY",          authKey: "zai",                   passPatterns: ["api/zai"],                       billing: "pay_per_token" },
  "huggingface":         { envVar: "HF_TOKEN",             authKey: "huggingface",           passPatterns: ["api/huggingface", "api/hf"],     billing: "pay_per_token" },
  "kimi-coding":         { envVar: "KIMI_API_KEY",         authKey: "kimi-coding",           passPatterns: ["api/kimi"],                      billing: "pay_per_token" },
  "minimax":             { envVar: "MINIMAX_API_KEY",      authKey: "minimax",               passPatterns: ["api/minimax"],                   billing: "pay_per_token" },
  "minimax-cn":          { envVar: "MINIMAX_CN_API_KEY",   authKey: "minimax-cn",            passPatterns: [],                                billing: "pay_per_token" },
  "opencode":            { envVar: "OPENCODE_API_KEY",     authKey: "opencode",              passPatterns: ["api/opencode"],                  billing: "pay_per_token" },
  "opencode-go":         { envVar: "OPENCODE_API_KEY",     authKey: "opencode-go",           passPatterns: [],                                billing: "pay_per_token" },
  "vercel-ai-gateway":   { envVar: "AI_GATEWAY_API_KEY",   authKey: "vercel-ai-gateway",     passPatterns: ["api/vercel"],                    billing: "pay_per_token" },
  "azure-openai":        { envVar: "AZURE_OPENAI_API_KEY", authKey: "azure-openai-responses",passPatterns: ["api/azure"],                     billing: "pay_per_token" },
  "deepseek":            { envVar: "DEEPSEEK_API_KEY",     authKey: "deepseek",              passPatterns: ["api/deepseek"],                  billing: "pay_per_token", modelsUrl: "https://api.deepseek.com/models", authHeader: k => ({ "Authorization": `Bearer ${k}` }), baseUrl: "https://api.deepseek.com", api: "openai-completions" },
  "github-copilot":      {                                 authKey: "github-copilot",        passPatterns: [],                                billing: "subscription" },
  "qwen-cli":            {                                 authKey: "qwen-cli",              passPatterns: [],  cliAuthFiles: [{ path: "~/.qwen/oauth_creds.json", tokenField: "access_token" }],  billing: "subscription", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions" },
  "gemini-cli":          {                                 authKey: "gemini-cli",            passPatterns: [],  cliAuthFiles: [{ path: "~/.gemini/oauth_creds.json", tokenField: "access_token" }],  billing: "subscription" },
  "antigravity":         {                                 authKey: "antigravity",           passPatterns: [],                                billing: "subscription" },
  "ollama":              { local: true,                                                      passPatterns: [],                                billing: "subscription" },
  "lm-studio":           { local: true,                                                      passPatterns: [],                                billing: "subscription" },
};

const STRIP_SUF = _defaults.strip_suffixes;

function stripDateSuffix(s: string): string {
  // Strip trailing date/version tags: -YYYYMMDD, -YYMMDD, -YYMM (e.g., -20250514, -2507, -0324)
  return s.replace(/-\d{4,8}$/, "");
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const extDir = path.dirname(fileURLToPath(import.meta.url));
  const cfgPath = path.join(extDir, "router-config.json");
  const cachePath = path.join(extDir, ".cache/scan-cache.json");

  let cfg: Config;
  let cache: Cache = {};
  let metrics: Record<string, Metrics> = {};
  let limits = new Map<string, RateLimit>();
  let rrCounters: Record<string, number> = {};
  let gdpval: Record<string, number> = {};
  let scanning = false;
  let activeGroup: string | null = null;
  let sessionStart = Date.now();
  let turnStart = 0;
  let curModel = "";
  let sessionCtx: any = null;

  // ── Helpers ────────────────────────────────────────────────────────────

  function norm(s: string): string {
    s = s.toLowerCase();
    // Strip to last path segment — "chutes/deepseek-ai/DeepSeek-V3" → "deepseek-v3"
    const slash = s.lastIndexOf("/");
    if (slash !== -1 && slash < s.length - 1) s = s.slice(slash + 1);
    for (const x of STRIP_SUF) s = s.replace(x, "");
    s = stripDateSuffix(s);
    return s.replace(/[^a-z0-9]/g, "");
  }

  // ── Model Map: authoritative model → GDPval slug mapping ────────────

  // Load model-map.yaml: maps "modelId" → "gdpval-slug" (or null)
  type ModelMap = Record<string, string | null>;
  let modelMap: ModelMap = {};
  let modelMapWildcards: [string, string | null][] = []; // [prefix, slug]

  function loadModelMap() {
    const mapPath = path.join(extDir, "model-map.yaml");
    try {
      const raw = YAML.parse(fs.readFileSync(mapPath, "utf-8")) as Record<string, string | null>;
      modelMap = {};
      modelMapWildcards = [];
      for (const [key, slug] of Object.entries(raw)) {
        if (key === null || typeof key !== "string") continue;
        if (key.endsWith("*")) {
          modelMapWildcards.push([key.slice(0, -1), slug]);
        } else {
          modelMap[key] = slug;
        }
      }
      // Sort wildcards longest-first for most specific match
      modelMapWildcards.sort((a, b) => b[0].length - a[0].length);
    } catch { /* no map file, use fallback only */ }
  }

  /** Strip provider prefix from ref: "chutes/deepseek-ai/DeepSeek-V3" → "deepseek-ai/DeepSeek-V3" */
  function stripProvider(ref: string): string {
    const i = ref.indexOf("/");
    if (i === -1) return ref;
    const prov = ref.slice(0, i);
    if (PROVIDER_MAP[prov] || cfg?.providers?.[prov]) return ref.slice(i + 1);
    return ref;
  }

  /** Look up GDPval slug for a model ref using model-map.yaml */
  function mapLookup(ref: string): string | null | undefined {
    const modelId = stripProvider(ref);
    // Exact match
    if (modelId in modelMap) return modelMap[modelId];
    // Wildcard match (longest prefix first)
    for (const [prefix, slug] of modelMapWildcards) {
      if (modelId.startsWith(prefix)) return slug;
    }
    return undefined; // not in map
  }

  // ── GDPval token-set fallback (for models not in model-map.yaml) ───

  // GDPval parameter suffixes — same base model, different inference params
  const PARAM_SUFFIXES = ["-non-reasoning-low-effort", "-non-reasoning-high-effort",
    "-adaptive", "-non-reasoning", "-reasoning", "-thinking",
    "-low-effort", "-high-effort", "-max-effort"];

  /** Extract base model tokens: strip params, suffixes, dates, then split to sorted token set */
  function baseTokens(s: string): Set<string> {
    s = s.toLowerCase();
    const slash = s.lastIndexOf("/");
    if (slash !== -1 && slash < s.length - 1) s = s.slice(slash + 1);
    for (const ps of PARAM_SUFFIXES) s = s.replace(ps, "");
    for (const x of STRIP_SUF) s = s.replace(x, "");
    s = stripDateSuffix(s);
    return new Set(s.match(/[a-z]+|\d+/g) ?? []);
  }

  // Lazily-built token index for fallback matching
  let gdpvalIndex: Map<string, number> | null = null;
  let gdpvalVersion = 0;
  let lastIndexVersion = -1;

  function buildGdpvalIndex() {
    gdpvalIndex = new Map();
    for (const [slug, score] of Object.entries(gdpval)) {
      const key = [...baseTokens(slug)].sort().join("|");
      const existing = gdpvalIndex.get(key);
      if (existing === undefined || score > existing) gdpvalIndex.set(key, score);
    }
    lastIndexVersion = gdpvalVersion;
  }

  function lookupGdp(id: string): number | null {
    // Primary: model-map.yaml explicit mapping
    const mapped = mapLookup(id);
    if (mapped === null) return null; // explicitly no score
    if (mapped !== undefined) {
      // Find the slug's score (take highest across parameter variants)
      if (lastIndexVersion !== gdpvalVersion) buildGdpvalIndex();
      const key = [...baseTokens(mapped)].sort().join("|");
      return gdpvalIndex!.get(key) ?? null;
    }
    // Fallback: automatic token-set matching
    if (lastIndexVersion !== gdpvalVersion) buildGdpvalIndex();
    const key = [...baseTokens(id)].sort().join("|");
    return gdpvalIndex!.get(key) ?? null;
  }

  function splitRef(ref: string) {
    const i = ref.indexOf("/");
    return i === -1 ? { provider: ref, modelId: ref } : { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
  }

  function fmt(n: number) { return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`; }

  function fmtTime(ms: number) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return `${m}m${rs ? rs + "s" : ""}`;
    return `${Math.floor(m / 60)}h${m % 60 ? (m % 60) + "m" : ""}`;
  }

  // ── Config + Cache ─────────────────────────────────────────────────────

  function load() {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    if (cfg.gdpval_builtin) { Object.assign(gdpval, cfg.gdpval_builtin); gdpvalVersion++; }
  }

  function loadCache() {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      if (fs.existsSync(cachePath)) {
        cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        if (cache.gdpval_scores) { gdpval = { ...cache.gdpval_scores }; gdpvalVersion++; }
        if (cache.benchmarks) {
          for (const [ref, tps] of Object.entries(cache.benchmarks)) {
            if (!metrics[ref]) metrics[ref] = { gdpval: lookupGdp(ref) ?? 50, throughput_tps: tps, avg_latency_ms: tps > 0 ? 100000 / tps : 1000, cost_per_m: 0, last_updated: Date.now() };
          }
        }
      }
    } catch { /* first run */ }
  }

  function saveCache() {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  }

  // ── Key Discovery ───────────────────────────────────────────────────────

  let passEntries: string[] | null = null; // cached pass ls output
  let discoveredProviders = new Set<string>();

  function parsePassTree(): string[] {
    if (passEntries !== null) return passEntries;
    try {
      // Redirect stderr to suppress "pass not found" errors in containers without pass
      const raw = execSync("pass ls 2>/dev/null", { encoding: "utf-8", timeout: 5000 });
      // Parse tree output: extract leaf paths from lines like "├── api-key" or "│   └── token"
      const lines = raw.split("\n");
      const stack: string[] = [];
      const entries: string[] = [];
      for (let line of lines) {
        // Strip ANSI escape codes (colors from pass ls output)
        line = line.replace(/\x1b\[[0-9;]*m/g, "");
        if (line === "Password Store" || !line.trim()) continue;
        // Determine depth by counting tree prefixes (each level is 4 chars: "│   " or "    ")
        const stripped = line.replace(/[│├└─\s]/g, "");
        if (!stripped) continue;
        const depth = Math.floor((line.length - line.replace(/^[^a-zA-Z0-9]+/, "").length) / 4);
        stack.length = depth;
        stack[depth] = stripped;
        entries.push(stack.filter(Boolean).join("/"));
      }
      passEntries = entries;
    } catch { passEntries = []; }
    return passEntries;
  }

  function discoverKeys() {
    const auth = loadAuth();
    const entries = parsePassTree();

    for (const [provId, def] of Object.entries(PROVIDER_MAP)) {
      if (!cfg.providers) cfg.providers = {};
      if (!cfg.providers[provId]) cfg.providers[provId] = { billing: def.billing ?? "pay_per_token" };
      const prov = cfg.providers[provId];
      if (!prov.keys) prov.keys = [];

      const existingLabels = new Set(prov.keys.map(k => k.label ?? k.key));

      // 1. Env var
      if (def.envVar && process.env[def.envVar]) {
        const label = `env:${def.envVar}`;
        if (!existingLabels.has(label)) {
          prov.keys.push({ key: def.envVar, label });
          existingLabels.add(label);
        }
      }

      // 2. auth.json
      if (def.authKey && auth[def.authKey]) {
        const authEntry = auth[def.authKey];
        const label = "auth.json";
        if (!existingLabels.has(label)) {
          // Store as reference — the key field from auth.json if it's an api_key type
          if (authEntry.key) {
            prov.keys.push({ key: authEntry.key, label });
          } else if (authEntry.type === "oauth" || authEntry.refresh) {
            // OAuth — mark as available but key rotation doesn't apply
            prov.keys.push({ key: `__oauth__:${def.authKey}`, label: "auth.json:oauth" });
          }
          existingLabels.add(label);
        }
      }

      // 3. Pass store
      if (def.passPatterns) {
        for (const pattern of def.passPatterns) {
          const matches = entries.filter(e => e.startsWith(pattern + "/") || e === pattern);
          for (const m of matches) {
            const label = `pass:${m}`;
            if (!existingLabels.has(label)) {
              prov.keys.push({ key: `!pass show ${m}`, label });
              existingLabels.add(label);
            }
          }
        }
      }

      // 4. CLI auth files (e.g. ~/.qwen/oauth_creds.json, ~/.gemini/oauth_creds.json)
      //    Also sync fresh tokens to pi's auth.json so OAuth flow uses them
      if (def.cliAuthFiles) {
        for (const af of def.cliAuthFiles) {
          const filePath = af.path.replace("~", homedir());
          const label = `cli:${af.path}`;
          if (!existingLabels.has(label)) {
            try {
              if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
                if (data[af.tokenField]) {
                  prov.keys.push({ key: `__cli_oauth__:${filePath}:${af.tokenField}`, label });
                  existingLabels.add(label);

                  // Sync CLI OAuth token to pi's auth.json if newer
                  if (def.authKey && data.expiry_date) {
                    try {
                      const auth = loadAuth();
                      const existing = auth[def.authKey];
                      if (existing?.type === "oauth" && data.expiry_date > (existing.expires ?? 0)) {
                        existing.access = data[af.tokenField];
                        if (data.refresh_token) existing.refresh = data.refresh_token;
                        existing.expires = data.expiry_date;
                        saveAuth(auth);
                      }
                    } catch { /* sync failed, non-fatal */ }
                  }
                }
              }
            } catch { /* unreadable */ }
          }
        }
      }

      // 5. Local providers — just mark as available
      if (def.local) {
        if (!existingLabels.has("local")) {
          prov.keys.push({ key: "__local__", label: "local" });
          existingLabels.add("local");
        }
      }

      // Track discovered (has at least one key not from config)
      if (prov.keys.length > 0) discoveredProviders.add(provId);

      // Clean up empty providers
      if (prov.keys.length === 0) delete cfg.providers[provId];
    }
  }

  // ── Scan (GDPval forever, models 24hr) ─────────────────────────────────

  async function fetchJson(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<any> {
    const res = await fetch(url, {
      headers: { "User-Agent": "pi-model-router/1.0", ...opts?.headers },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  async function scan(force = false) {
    if (scanning) return;
    scanning = true;
    try {
      if (!cache.gdpval_scraped || force) {
        try {
          const res = await fetch(GDPVAL_URL, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(30_000),
          });
          const html = await res.text().then(h => h.replace(/\\"/g, '"'));
          // Extract slug → name mapping from JSON data embedded in page
          const slugMap: Record<string, string> = {};
          const slugRe = /"([a-z0-9][a-z0-9._-]+)","name":"([^"]+)","shortName":"([^"]+)"/g;
          let sm; while ((sm = slugRe.exec(html))) { slugMap[sm[2]] = sm[1]; if (sm[3] !== sm[2]) slugMap[sm[3]] = sm[1]; }
          // Extract name → score from HTML table
          const tableRe = /<div[^>]*>([^<]{3,80})<\/div><\/td>\s*<td[^>]*>(\d{3,4})<\/td>/g;
          let m; const scores: Record<string, number> = {};
          while ((m = tableRe.exec(html))) {
            const nm = m[1].trim().replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
            if (!nm || !/[A-Za-z]/.test(nm) || nm.startsWith("<")) continue;
            const score = +m[2];
            // Prefer slug key (machine-readable) over display name
            const slug = slugMap[nm];
            const key = slug ?? nm;
            if (!scores[key] || score > scores[key]) scores[key] = score;
          }
          if (Object.keys(scores).length) { gdpval = { ...scores }; gdpvalVersion++; cache.gdpval_scores = gdpval; cache.gdpval_scraped = true; }
        } catch { /* scrape failed, use builtins */ }
      }
      const age = cache.models_cached ? Date.now() - new Date(cache.models_cached).getTime() : Infinity;
      // Also rescan if any configured provider has keys but zero models cached
      const missingProviders = Object.entries(cfg.providers ?? {})
        .some(([p, pc]) => pc.keys?.length && !(cache.available_models ?? []).some(m => m.provider === p));
      if (force || age > MODELS_TTL || missingProviders) {
        const models: Cache["available_models"] = [];
        try {
          const d = await fetchJson("https://llm.chutes.ai/v1/models");
          const pricing = cache.openrouter_pricing ?? {};
          for (const m of d.data ?? []) {
            models.push({ id: m.id, provider: "chutes", cost_per_m: m.pricing?.prompt ?? 0 });
            const inp = m.pricing?.prompt ?? 0;
            const out = m.pricing?.completion ?? 0;
            if (inp >= 0 && out >= 0) {
              const ref = `chutes/${m.id}`;
              if (!pricing[ref] || inp < pricing[ref].input) pricing[ref] = { input: inp, output: out };
            }
          }
          cache.openrouter_pricing = pricing;
        } catch {}
        try {
          const d = await fetchJson("https://openrouter.ai/api/v1/models", { timeoutMs: 25_000 });
          const pricing: Record<string, { input: number; output: number }> = cache.openrouter_pricing ?? {};
          for (const m of d.data ?? []) {
            if (String(m.pricing?.prompt ?? "1") === "0") models.push({ id: m.id, provider: "openrouter", cost_per_m: 0 });
            const inp = parseFloat(m.pricing?.prompt ?? "0") * 1_000_000;
            const out = parseFloat(m.pricing?.completion ?? "0") * 1_000_000;
            if (inp >= 0 && out >= 0) {
              const ref = `openrouter/${m.id}`;
              pricing[ref] = { input: inp, output: out };
              if (m.id.includes("/") && inp > 0) {
                if (!pricing[m.id] || inp < pricing[m.id].input) pricing[m.id] = { input: inp, output: out };
              }
            }
          }
          cache.openrouter_pricing = pricing;
        } catch {}
        // Scan direct API providers with modelsUrl (anthropic, openai, etc.)
        const providerScans = Object.entries(PROVIDER_MAP)
          .filter(([, def]) => def.modelsUrl && def.authHeader)
          .map(async ([provId, def]) => {
            const keys = cfg.providers?.[provId]?.keys;
            if (!keys?.length) return;
            // Try each key until one succeeds (first may be stale)
            for (let ki = 0; ki < keys.length; ki++) {
              try {
                const key = resolveKeyValue(keys[ki].key);
                const headers = def.authHeader!(key);
                const d = await fetchJson(def.modelsUrl!, { headers, timeoutMs: 15_000 });
                const list = d.data ?? d.models ?? [];
                if (!list.length) continue;
                for (const m of list) {
                  const id = m.id ?? m.name?.replace(/^models\//, "");
                  if (!id) continue;
                  if (/embed|tts|whisper|dall|moderation|babbage|davinci|search|audio|realtime|image|transcri/i.test(id)) continue;
                  const existing = models.find(x => x.provider === provId && x.id === id);
                  if (!existing) models.push({ id, provider: provId, cost_per_m: 0 });
                }
                break; // success, stop trying keys
              } catch { /* try next key */ }
            }
          });
        await Promise.allSettled(providerScans);
        if (models.length) {
          // Merge: keep existing entries for providers not scanned (or whose scan failed)
          const scannedProviders = new Set(models.map(m => m.provider));
          const kept = (cache.available_models ?? []).filter(m => !scannedProviders.has(m.provider));
          cache.available_models = [...kept, ...models];
          cache.models_cached = new Date().toISOString();
        }
      }
      saveCache();
    } finally { scanning = false; }
  }

  // ── Metrics ────────────────────────────────────────────────────────────

  function getM(ref: string): Metrics {
    if (metrics[ref]) return metrics[ref];
    const cm = cfg.model_metrics[ref] ?? {};
    return metrics[ref] = { gdpval: lookupGdp(ref) ?? cm.gdpval ?? 50, throughput_tps: cm.throughput_tps ?? 100, avg_latency_ms: cm.avg_latency_ms ?? 1000, cost_per_m: cm.cost_per_m ?? 0, last_updated: Date.now() };
  }

  function updateMetrics(ref: string, latMs: number, tokens: number, durMs: number) {
    const m = getM(ref), α = 0.3;
    m.avg_latency_ms = m.avg_latency_ms * (1 - α) + latMs * α;
    if (durMs > 0 && tokens > 0) { m.throughput_tps = m.throughput_tps * (1 - α) + (tokens / durMs * 1000) * α; if (!cache.benchmarks) cache.benchmarks = {}; cache.benchmarks[ref] = m.throughput_tps; }
    m.last_updated = Date.now();
  }

  // ── Rate Limit + costMux ───────────────────────────────────────────────

  const AUTH_PATH = path.join(homedir(), ".pi", "agent", "auth.json");
  const KEY_COOLDOWN = 3_600_000; // 1hr per exhausted key
  let activeKeyIdx: Record<string, number> = {}; // provider → current key index

  function resolveKeyValue(key: string): string {
    if (key.startsWith("!pass show ")) {
      try { return execSync(key.slice(1) + " 2>/dev/null", { encoding: "utf-8" }).trim(); }
      catch { return key; }
    }
    if (key.startsWith("__cli_oauth__:")) {
      // Format: __cli_oauth__:/path/to/creds.json:tokenField
      const parts = key.slice("__cli_oauth__:".length);
      const lastColon = parts.lastIndexOf(":");
      const filePath = parts.slice(0, lastColon);
      const field = parts.slice(lastColon + 1);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (data[field]) return data[field];
      } catch { /* unreadable */ }
    }
    return key;
  }

  function loadAuth(): any {
    try { return JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8")); } catch { return {}; }
  }

  function saveAuth(auth: any) {
    fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
  }

  function isKeyExhausted(prov: string, idx: number): boolean {
    const until = cache.exhausted_keys?.[`${prov}:${idx}`];
    if (!until) return false;
    if (Date.now() >= until) { delete cache.exhausted_keys![`${prov}:${idx}`]; return false; }
    return true;
  }

  function exhaustKey(prov: string, idx: number) {
    if (!cache.exhausted_keys) cache.exhausted_keys = {};
    cache.exhausted_keys[`${prov}:${idx}`] = Date.now() + KEY_COOLDOWN;
    saveCache();
  }

  /** Try rotating to next available key for provider. Returns true if switched. */
  function rotateKey(prov: string): boolean {
    const keys = cfg.providers?.[prov]?.keys;
    if (!keys || keys.length <= 1) return false;
    const curIdx = activeKeyIdx[prov] ?? 0;
    exhaustKey(prov, curIdx);
    for (let i = 1; i < keys.length; i++) {
      const nextIdx = (curIdx + i) % keys.length;
      if (!isKeyExhausted(prov, nextIdx)) {
        const resolved = resolveKeyValue(keys[nextIdx].key);
        const auth = loadAuth();
        if (auth[prov]) {
          // Update the key/token in auth.json
          if (auth[prov].key) auth[prov].key = keys[nextIdx].key;
          else if (auth[prov].type === "api_key") auth[prov].key = keys[nextIdx].key;
          else auth[prov].key = keys[nextIdx].key; // fallback: set key field
          saveAuth(auth);
        }
        activeKeyIdx[prov] = nextIdx;
        return true;
      }
    }
    return false; // all keys exhausted
  }

  function activeKeyLabel(prov: string): string | null {
    const keys = cfg.providers?.[prov]?.keys;
    if (!keys || keys.length <= 1) return null;
    const idx = activeKeyIdx[prov] ?? 0;
    return keys[idx]?.label ?? `key-${idx}`;
  }

  function costMux(prov: string) { return cache.cost_mux?.[prov] ?? 1; }

  function bumpMux(prov: string, modelId: string) {
    // 1/day guard
    const last = cache.cost_mux_last_bump?.[prov];
    if (last && new Date(last).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) return;
    // verify model still hosted
    if (cache.available_models && !cache.available_models.some(m => m.provider === prov && m.id === modelId)) return;
    if (!cache.cost_mux) cache.cost_mux = {};
    if (!cache.cost_mux_last_bump) cache.cost_mux_last_bump = {};
    cache.cost_mux[prov] = (cache.cost_mux[prov] ?? 1) + 1;
    cache.cost_mux_last_bump[prov] = new Date().toISOString();
    saveCache();
  }

  function isLimited(ref: string) {
    const e = limits.get(ref);
    if (!e) return false;
    if (Date.now() >= e.cooldown_until) { limits.delete(ref); return false; }
    return true;
  }

  function recordLimit(ref: string): { rotated: boolean; newKey?: string } {
    const { provider } = splitRef(ref);
    // Try key rotation first — if we have another key, use it instead of backing off the model
    if (rotateKey(provider)) {
      const label = activeKeyLabel(provider) ?? "next";
      return { rotated: true, newKey: label };
    }
    // No keys to rotate — fall back to model-level backoff
    const prev = limits.get(ref);
    const hits = (prev?.hits ?? 0) + 1;
    const ms = BACKOFF[Math.min(hits - 1, BACKOFF.length - 1)];
    limits.set(ref, { cooldown_until: Date.now() + ms, backoff_ms: ms, hits });
    if (hits === COST_MUX_AT_HIT) { const { provider: p, modelId } = splitRef(ref); bumpMux(p, modelId); }
    return { rotated: false };
  }

  function recordOk(ref: string) { const e = limits.get(ref); if (e) e.hits = 0; }

  /** Record a soft failure (empty response, timeout) — lighter backoff than 429 */
  function recordSoftFailure(ref: string): void {
    const prev = limits.get(ref);
    const hits = (prev?.hits ?? 0) + 1;
    const ms = SOFT_BACKOFF[Math.min(hits - 1, SOFT_BACKOFF.length - 1)];
    limits.set(ref, { cooldown_until: Date.now() + ms, backoff_ms: ms, hits });
  }

  function limitSecs(ref: string) { const e = limits.get(ref); return e ? Math.max(0, Math.ceil((e.cooldown_until - Date.now()) / 1000)) : 0; }

  // ── Usage Stats ────────────────────────────────────────────────────────

  function getUsage(ref: string, days: number): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return (cache.usage_log ?? [])
      .filter(e => e.ref === ref && e.ts > cutoff)
      .reduce((sum, e) => sum + e.tokens, 0);
  }

  function getUsageAll(days: number): Record<string, number> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const result: Record<string, number> = {};
    for (const e of cache.usage_log ?? []) {
      if (e.ts > cutoff) result[e.ref] = (result[e.ref] ?? 0) + e.tokens;
    }
    return result;
  }

  // ── Price lookup (OpenRouter as oracle) ─────────────────────────────────

  function lookupPrice(ref: string): { input: number; output: number } | null {
    // 1. Check config metrics first
    const cm = cfg.model_metrics[ref];
    if (cm?.cost_per_m) return { input: cm.cost_per_m, output: cm.cost_per_m };

    // 2. Check pricing cache by exact provider/model ref
    if (cache.openrouter_pricing?.[ref]) return cache.openrouter_pricing[ref];

    // 3. Backfill: find paid OpenRouter pricing for same model (skip $0 free-tier)
    const { modelId } = splitRef(ref);
    const n = norm(modelId);
    for (const [k, v] of Object.entries(cache.openrouter_pricing ?? {})) {
      if (v.input <= 0) continue; // skip free-tier
      const kModel = k.indexOf("/") >= 0 ? k.slice(k.indexOf("/") + 1) : k;
      if (norm(kModel) === n) return v;
    }
    return null;
  }

  // ── Effective cost ─────────────────────────────────────────────────────

  function effCost(ref: string): number {
    const m = getM(ref), prov = ref.split("/")[0];
    // 1. Use metrics cost_per_m if set
    let base = m.cost_per_m;
    // 2. Look up in OpenRouter/Chutes pricing cache
    if (!base) {
      const price = lookupPrice(ref);
      if (price) base = price.input; // use input price as representative
    }
    // 3. Fallback to tiny base (costMux still differentiates free models)
    if (!base) base = 0.01;
    // Apply subscription discount
    if (cfg.providers?.[prov]?.billing === "subscription") base *= SUB_DISCOUNT;
    return base * costMux(prov);
  }

  // ── Resolution ─────────────────────────────────────────────────────────

  // ── Auto-discovery ────────────────────────────────────────────────────

  /** All known model refs: auto-discovered + any pinned models in group config */
  function allDiscoveredRefs(): string[] {
    const refs = new Set<string>();
    for (const m of cache.available_models ?? []) refs.add(`${m.provider}/${m.id}`);
    for (const g of Object.values(cfg.model_groups)) {
      for (const r of g.models ?? []) refs.add(r);
    }
    return [...refs];
  }

  /** Get billing tier for a model ref: 0=free, 1=subscription, 2=local, 3=payg */
  function billingTier(ref: string): number {
    const prov = ref.split("/")[0];
    const provDef = PROVIDER_MAP[prov];
    const provCfg = cfg.providers?.[prov];
    const billing = provCfg?.billing ?? provDef?.billing ?? "pay_per_token";
    // Local providers (ollama, lm-studio)
    if (provDef?.local) return 2;
    // Subscription providers — trust provider billing over per-model cost_per_m
    // (APIs like Anthropic report cost_per_m=0 because pricing isn't in /v1/models)
    if (billing === "subscription") return 1;
    // Free models (openrouter :free variants, or genuinely free PAYG models)
    const discovered = (cache.available_models ?? []).find(m => `${m.provider}/${m.id}` === ref);
    if (discovered?.cost_per_m === 0) return 0;
    return 3; // pay per token
  }

  /** Check provider key health: "valid" if key exists and not exhausted, "exhausted" if all keys spent, "unchecked" if no keys configured */
  function providerKeyHealth(prov: string): "valid" | "exhausted" | "unchecked" {
    const keys = cfg.providers?.[prov]?.keys;
    if (!keys || keys.length === 0) return "unchecked";
    const idx = activeKeyIdx[prov] ?? 0;
    if (isKeyExhausted(prov, idx)) {
      // Check if any key is available
      for (let i = 0; i < keys.length; i++) {
        if (!isKeyExhausted(prov, i)) return "valid";
      }
      return "exhausted";
    }
    return "valid";
  }

  /** Filter to available models (not rate-limited, healthy provider keys) */
  function filterAvailable(refs: string[]): string[] {
    return refs.filter(r => {
      if (isLimited(r)) return false;
      const { provider } = splitRef(r);
      const health = providerKeyHealth(provider);
      return health === "valid" || health === "unchecked";
    });
  }

  /** Filter by minimum gdpval percentile (0-100). Keeps models at or above the percentile threshold. */
  function filterByQualityPct(refs: string[], pct: number): string[] {
    if (!refs.length || pct <= 0) return refs;
    const gdps = refs.map(r => getM(r).gdpval).sort((a, b) => a - b);
    const idx = Math.floor((pct / 100) * (gdps.length - 1));
    const threshold = gdps[idx];
    return refs.filter(r => getM(r).gdpval >= threshold);
  }

  /** Filter by absolute minimum gdpval score. Falls back to all refs if none qualify. */
  function filterByQualityMin(refs: string[], min: number): string[] {
    if (!refs.length || min <= 0) return refs;
    const filtered = refs.filter(r => getM(r).gdpval >= min);
    return filtered.length ? filtered : refs;
  }

  /**
   * Sort by billing preference: free → subscription (by rate-limit pressure & cost) → local → PAYG (by cost)
   * Within each tier, sort by effective cost. Subscription also considers rate-limit pressure.
   */
  function sortByBillingPreference(refs: string[]): string[] {
    return [...refs].sort((a, b) => {
      const ta = billingTier(a), tb = billingTier(b);
      if (ta !== tb) return ta - tb;
      // Within subscription tier, prefer lower rate-limit pressure first, then cost
      if (ta === 1) {
        const pa = limitSecs(a), pb = limitSecs(b);
        if (pa !== pb) return pa - pb;
      }
      return effCost(a) - effCost(b);
    });
  }

  function available(g: Group) {
    let c = allDiscoveredRefs();
    if (g.min_gdpval != null) c = filterByQualityMin(c, g.min_gdpval);
    else if (g.min_gdpval_pct != null) c = filterByQualityPct(c, g.min_gdpval_pct);
    return filterAvailable(c);
  }

  function sortBy(models: string[], method: string): string[] {
    const s = [...models];
    if (method === "min_latency") return s.sort((a, b) => getM(a).avg_latency_ms - getM(b).avg_latency_ms);
    if (method === "max_throughput") return s.sort((a, b) => getM(b).throughput_tps - getM(a).throughput_tps);
    if (method === "min_cost") return s.sort((a, b) => effCost(a) - effCost(b) || getM(b).gdpval - getM(a).gdpval);
    if (method === "max_gdpval") return s.sort((a, b) => getM(b).gdpval - getM(a).gdpval);
    if (method === "billing_preference") return sortByBillingPreference(s);
    if (method === "roundrobin") return s;
    return s;
  }

  function resolve(name: string): { selected: string; candidates: string[] } | null {
    const g = cfg.model_groups[name];
    if (!g) return null;
    let c = available(g);
    if (!c.length) return null;

    if (g.method === "best") {
      // Strategic: highest gdpval available
      c = sortBy(c, "max_gdpval");
    } else if (g.method === "tiered") {
      // Quality-gated + billing preference
      c = sortByBillingPreference(c);
    } else if (g.method === "pipeline" && g.pipeline) {
      for (const step of g.pipeline) { c = sortBy(c, step.method); if (step.top_k && step.top_k < c.length) c = c.slice(0, step.top_k); }
    } else if (g.method === "roundrobin") {
      const i = (rrCounters[name] ?? 0) % c.length; rrCounters[name] = i + 1;
      c = [...c.slice(i), ...c.slice(0, i)];
    } else {
      c = sortBy(c, g.method); if (g.top_k && g.top_k < c.length) c = c.slice(0, g.top_k);
    }
    return { selected: c[0], candidates: c };
  }

  // ── Format ─────────────────────────────────────────────────────────────

  function fmtModel(ref: string, i: number, sel: boolean) {
    const m = getM(ref), prov = ref.split("/")[0], mux = costMux(prov);
    const billing = cfg.providers?.[prov]?.billing === "subscription" ? "sub" : m.cost_per_m === 0 ? "free" : "ppt";
    const muxS = mux > 1 ? ` ×${mux}` : "";
    const rl = isLimited(ref) ? ` ⛔${limitSecs(ref)}s` : "";
    return `${i + 1}. ${ref}  gdp:${m.gdpval}  tps:${Math.round(m.throughput_tps)}  eff:$${effCost(ref).toFixed(3)}/M  [${billing}${muxS}]${rl}${sel ? " ←" : ""}`;
  }

  // Get top N models for a group, including rate-limited ones (for display)
  function getTopModels(groupName: string, n: number): { ref: string; limited: boolean; rank: number }[] {
    const g = cfg.model_groups[groupName];
    if (!g) return [];
    let c = allDiscoveredRefs();
    if (g.min_gdpval != null) c = filterByQualityMin(c, g.min_gdpval);
    else if (g.min_gdpval_pct != null) c = filterByQualityPct(c, g.min_gdpval_pct);

    if (g.method === "best") {
      c = sortBy(c, "max_gdpval");
    } else if (g.method === "tiered") {
      c = sortByBillingPreference(c);
    } else if (g.method === "pipeline" && g.pipeline) {
      for (let i = 0; i < g.pipeline.length; i++) {
        const step = g.pipeline[i];
        c = sortBy(c, step.method);
        const isLastStep = i === g.pipeline.length - 1;
        if (step.top_k && step.top_k < c.length && !isLastStep) c = c.slice(0, step.top_k);
      }
    } else {
      c = sortBy(c, g.method);
    }

    const avail = c.filter(ref => !isLimited(ref));
    const limited = c.filter(ref => isLimited(ref));
    const ranked = [...avail, ...limited];
    return ranked.slice(0, n).map((ref, i) => ({ ref, limited: isLimited(ref), rank: i }));
  }

  function detectGroup(ref: string): string | null {
    if (activeGroup) return activeGroup;
    for (const [n, g] of Object.entries(cfg.model_groups)) if (g.models?.includes(ref)) return n;
    // With auto-discovery, any available model belongs to any group — return lowest tier that includes it
    const refs = allDiscoveredRefs();
    if (refs.includes(ref)) {
      for (const name of ["scout", "operational", "tactical", "strategic"]) {
        if (cfg.model_groups[name]) return name;
      }
    }
    return null;
  }

  /**
   * Register virtual providers for each model group (strategic, tactical, etc).
   * Called synchronously during extension load so groups are available for
   * --model resolution before session_start fires.
   */
  function registerGroupProviders() {
    for (const [groupName] of Object.entries(cfg.model_groups)) {
      const res = resolve(groupName);
      const resolvedRef = res?.selected ?? "none";
      const resolvedMetrics = res ? getM(resolvedRef) : null;

      pi.registerProvider(groupName, {
        baseUrl: "https://router.local", // not used — streamSimple overrides
        apiKey: "router-virtual",        // not used — streamSimple overrides
        api: `router-group-${groupName}`, // unique per group to avoid overwriting global API providers
        streamSimple: groupStream,
        models: [{
          id: groupName,
          name: `${groupName} → ${resolvedRef}`,
          reasoning: true,
          input: ["text", "image"] as any,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: resolvedMetrics ? 200_000 : 128_000,
          maxTokens: 64_000,
        }],
      });
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────

  load(); loadModelMap(); loadCache();
  registerGroupProviders();

  pi.on("session_start", async (_ev, ctx) => {
    sessionCtx = ctx;
    load(); loadModelMap(); loadCache(); sessionStart = Date.now();
    discoverKeys();

    await registerGroupModels(ctx);
    scan().catch(() => {});

    // Footer
    ctx.ui.setFooter((tui, theme, fd) => {
      const unsub = fd.onBranchChange(() => tui.requestRender());
      const timer = setInterval(() => tui.requestRender(), 30000);
      return {
        dispose() { unsub(); clearInterval(timer); },
        invalidate() {},
        render(w: number): string[] {
          const ref = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
          const grp = ref ? detectGroup(ref) : null;
          const m = ref ? getM(ref) : null;
          const rStr = theme.fg("accent", `${grp ?? "—"}/${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`);
          const iStr = m ? theme.fg("warning", `int:${m.gdpval}`) : "";
          const tStr = m ? theme.fg("success", `tps:${Math.round(m.throughput_tps)}`) : "";

          let inp = 0, out = 0, cost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const a = e.message as AssistantMessage; inp += a.usage.input; out += a.usage.output; cost += a.usage.cost.total;
            }
          }
          const u = ctx.getContextUsage(), pct = u?.percent ?? 0;
          const pCol = pct > 75 ? "error" : pct > 50 ? "warning" : "success";
          const tok = [theme.fg("accent", `${fmt(inp)}/${fmt(out)}`), theme.fg("warning", `$${cost.toFixed(2)}`), theme.fg(pCol, `${pct.toFixed(0)}%`)].join(" ");
          const el = theme.fg("dim", `⏱${fmtTime(Date.now() - sessionStart)}`);
          const pp = process.cwd().split("/"); const cwd = theme.fg("muted", `⌂ ${pp.length > 2 ? pp.slice(-2).join("/") : process.cwd()}`);
          const br = fd.getGitBranch(); const brS = br ? theme.fg("accent", `⎇ ${br}`) : "";
          const rlN = [...limits.keys()].filter(r => isLimited(r)).length;
          const rlS = rlN > 0 ? theme.fg("error", `⛔${rlN}`) : "";

          const sep = theme.fg("dim", " | ");
          const parts = [rStr]; if (iStr && tStr) parts.push(`${iStr} ${tStr}`);
          parts.push(tok, el, cwd); if (brS) parts.push(brS); if (rlS) parts.push(rlS);
          return [truncateToWidth(parts.join(sep), w)];
        },
      };
    });
  });

  pi.on("session_switch", async (ev) => { if (ev.reason === "new") sessionStart = Date.now(); });
  pi.on("model_select", async (ev) => { if (ev.source !== "restore") activeGroup = null; curModel = `${ev.model.provider}/${ev.model.id}`; });
  pi.on("turn_start", async (_ev, ctx) => { turnStart = Date.now(); if (ctx.model) curModel = `${ctx.model.provider}/${ctx.model.id}`; });

  pi.on("turn_end", async (ev) => {
    if (!curModel || !turnStart) return;
    const ms = Date.now() - turnStart, msg = ev.message;
    if (msg?.role === "assistant") {
      const txt = typeof msg.content === "string" ? msg.content : (msg.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const tok = Math.ceil(txt.length / 4);
      if (tok > 0) {
        updateMetrics(curModel, ms, tok, ms);
        recordOk(curModel);
        // Log usage
        if (!cache.usage_log) cache.usage_log = [];
        cache.usage_log.push({ ref: curModel, tokens: tok, ts: Date.now() });
        // Trim log to last 30 days
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        cache.usage_log = cache.usage_log.filter(e => e.ts > cutoff);
      }
    }
  });

  pi.on("tool_result", async (ev, ctx) => {
    if (ev.isError && curModel) {
      const txt = ev.content?.map((c: any) => c.text ?? "").join("") ?? "";
      if (txt.includes("429") || txt.toLowerCase().includes("rate limit")) {
        const result = recordLimit(curModel);
        if (result.rotated) {
          ctx.ui.notify(`🔑 Rate limited — rotated ${splitRef(curModel).provider} to key "${result.newKey}"`, "warning");
        }
      }
    }
  });

  let turns = 0;
  pi.on("turn_end", async () => { if (++turns % 10 === 0) saveCache(); });
  pi.on("session_shutdown", async () => saveCache());

  // ── Tools ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "set_model_from_group", label: "Set Model from Group",
    description: "Resolve a model group and immediately switch the current session to use the selected model. Combines resolve_model_group + model switch in one step.",
    promptGuidelines: ["When spawning subagents or selecting models for tasks, use resolve_model_group with the appropriate tier: strategic (best quality), tactical (quality/cost balance), operational (throughput/cost), scout (cheapest)."],
    parameters: Type.Object({ group: Type.String({ description: "Model group name" }) }),
    async execute(_id, params, _sig, _up, ctx) {
      load();
      const name = params.group.toLowerCase(), res = resolve(name);
      if (!res) throw new Error(`No models for group "${params.group}". Available: ${Object.keys(cfg.model_groups).join(", ")}`);
      for (const ref of res.candidates) {
        const { provider, modelId } = splitRef(ref);
        const model = ctx.modelRegistry.find(provider, modelId);
        if (model && await pi.setModel(model)) {
          activeGroup = name; const m = getM(ref);
          return { content: [{ type: "text", text: `${ref} (${name}, gdp:${m.gdpval}, tps:${Math.round(m.throughput_tps)})` }], details: { group: name, selected: ref, provider, modelId } };
        }
      }
      throw new Error(`No available model in "${name}". Tried: ${res.candidates.join(", ")}`);
    },
  });

  pi.registerTool({
    name: "resolve_model_group", label: "Resolve Model Group",
    description: "Resolve a model group name (strategic, tactical, operational, scout, fallback) to a concrete provider/model. Use this when you need to select a model for a subagent or task and want the router to pick the best one.",
    parameters: Type.Object({ group: Type.String({ description: "Model group name: strategic, tactical, operational, scout, fallback, or any custom group" }) }),
    async execute(_id, params) {
      load();
      const name = params.group.toLowerCase(), res = resolve(name);
      if (!res) throw new Error(`Unknown or empty group "${params.group}". Available: ${Object.keys(cfg.model_groups).join(", ")}`);
      const { provider, modelId } = splitRef(res.selected);
      const table = res.candidates.map((r, i) => fmtModel(r, i, i === 0)).join("\n");
      return { content: [{ type: "text", text: `"${name}" (${cfg.model_groups[name].method}) → ${res.selected}\n\n${table}` }], details: { group: name, selected: res.selected, provider, modelId, candidates: res.candidates } };
    },
  });

  pi.registerTool({
    name: "update_model_metrics", label: "Update Model Metrics",
    description: "Update runtime metrics (gdpval, throughput, latency) for a model in the router config.",
    parameters: Type.Object({ model_ref: Type.String({ description: "Model reference (provider/model-id)" }), gdpval: Type.Optional(Type.Number()), throughput_tps: Type.Optional(Type.Number()), avg_latency_ms: Type.Optional(Type.Number()) }),
    async execute(_id, p) {
      load(); const e = cfg.model_metrics[p.model_ref] ?? {};
      if (p.gdpval !== undefined) e.gdpval = p.gdpval; if (p.throughput_tps !== undefined) e.throughput_tps = p.throughput_tps; if (p.avg_latency_ms !== undefined) e.avg_latency_ms = p.avg_latency_ms;
      cfg.model_metrics[p.model_ref] = e; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      if (metrics[p.model_ref]) Object.assign(metrics[p.model_ref], e, { last_updated: Date.now() });
      return { content: [{ type: "text", text: `Updated ${p.model_ref}: ${JSON.stringify(e)}` }], details: { model_ref: p.model_ref, metrics: e } };
    },
  });

  // ── Virtual model groups: register as real pi models ──────────────────

  // ── Streaming helpers (hoisted for early group registration) ─────────

  /**
   * Try streaming from a specific model ref. Returns the stream and a
   * promise that resolves to { ok, hadContent, error? } when the stream
   * finishes or fails.
   */
  async function tryStream(
    ref: string,
    context: Context,
    options: SimpleStreamOptions | undefined,
  ): Promise<{ stream: AssistantMessageEventStream; ref: string } | null> {
    if (!sessionCtx) return null;
    const { provider, modelId } = splitRef(ref);
    // Skip group virtual models to prevent recursion
    if (cfg.model_groups[provider]) return null;
    const realModel = sessionCtx.modelRegistry.find(provider, modelId);
    if (!realModel) return null;
    if (cfg.model_groups[realModel.provider]) return null;
    // Resolve API key for the target provider (may come from customProviderApiKeys fallback)
    const apiKey = await sessionCtx.modelRegistry.getApiKey(realModel).catch(() => null);
    if (!apiKey) return null;
    const streamOpts = { ...options, apiKey };
    return { stream: piStreamSimple(realModel, context, streamOpts), ref };
  }

  /**
   * Consume an upstream stream, forwarding events to a proxy stream.
   * Detects soft failures: error events, or no content tokens within a
   * timeout window after the stream starts.
   *
   * Returns { ok: true } if the stream completed with content,
   * or { ok: false, reason } if it should be retried on another model.
   */
  async function consumeWithDetection(
    upstream: AssistantMessageEventStream,
    proxy: AssistantMessageEventStream,
    timeoutMs: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    let hadContent = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Start a timeout that fires if we never see content
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve("timeout"); }, timeoutMs);
    });

    // Race: iterate the stream vs timeout
    const iterPromise = (async (): Promise<"done"> => {
      try {
        for await (const event of upstream) {
          // Cancel timeout on first real content
          if (!hadContent) {
            const t = event.type;
            if (t === "text_delta" || t === "thinking_delta" || t === "toolcall_start" || t === "toolcall_delta") {
              hadContent = true;
              if (timer) { clearTimeout(timer); timer = null; }
            }
          }
          proxy.push(event);
          if (event.type === "error") {
            if (timer) { clearTimeout(timer); timer = null; }
            return "done";
          }
        }
      } catch (err) {
        if (timer) { clearTimeout(timer); timer = null; }
        // Stream threw — treat as soft failure
        return "done";
      }
      if (timer) { clearTimeout(timer); timer = null; }
      return "done";
    })();

    const winner = await Promise.race([iterPromise, timeoutPromise]);

    if (winner === "timeout" && !hadContent) {
      // No content within timeout — soft failure
      return { ok: false, reason: "empty_timeout" };
    }

    // Stream completed — check if we actually got content
    if (!hadContent) {
      return { ok: false, reason: "empty_response" };
    }

    return { ok: true };
  }

  /**
   * Stream with automatic retry on soft failures (empty responses, timeouts).
   * Creates a proxy AssistantMessageEventStream that consumers iterate.
   * On failure, records the model as soft-limited and tries the next candidate.
   */
  function groupStream(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
      const groupName = model.id;
      const res = resolve(groupName);
      if (!res) throw new Error(`No available models for group "${groupName}"`);

      const proxy = createAssistantMessageEventStream();
      const candidates = [...res.candidates];

      // Drive the proxy asynchronously
      (async () => {
        let lastError: string | undefined;

        for (let attempt = 0; attempt <= MAX_STREAM_RETRIES && candidates.length > 0; attempt++) {
          // Pick next available candidate (skip any that became limited between attempts)
          let target: { stream: AssistantMessageEventStream; ref: string } | null = null;
          let targetRef: string | undefined;

          while (candidates.length > 0) {
            const ref = candidates.shift()!;
            if (isLimited(ref)) continue;
            target = await tryStream(ref, context, options);
            if (target) { targetRef = ref; break; }
          }

          if (!target || !targetRef) break;

          const result = await consumeWithDetection(target.stream, proxy, EMPTY_RESPONSE_TIMEOUT_MS);

          if (result.ok) {
            // Success — record healthy, finalize proxy
            recordOk(targetRef);
            // The stream's done/error event was already forwarded via push()
            // The proxy will complete naturally via the pushed "done" event
            return;
          }

          // Soft failure — record and try next
          lastError = `${targetRef}: ${result.reason}`;
          recordSoftFailure(targetRef);

          // If we have more candidates, log the retry
          if (candidates.length > 0 && attempt < MAX_STREAM_RETRIES) {
            // Push a synthetic text event so the consumer sees what happened
            // (This is visible in the output as a brief note)
          }
        }

        // All retries exhausted — push an error event
        const errMsg: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: `[router] All candidates failed. Last: ${lastError ?? "no candidates"}` }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error",
          timestamp: Date.now(),
        } as AssistantMessage;
        proxy.push({ type: "error", reason: "error", error: errMsg } as AssistantMessageEvent);
      })().catch((err) => {
        // Unhandled error in the async driver — surface it
        const errMsg: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: `[router] Stream error: ${err instanceof Error ? err.message : String(err)}` }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error",
          timestamp: Date.now(),
        } as AssistantMessage;
        proxy.push({ type: "error", reason: "error", error: errMsg } as AssistantMessageEvent);
      });

      return proxy;
  }

  async function registerGroupModels(ctx: any) {
    // Register discovered providers with pi's model registry.
    // Skip providers that have dedicated extensions (CLI OAuth), built-in pi support,
    // or are already registered by another extension.
    const SKIP_REGISTRATION = new Set(
      Object.entries(PROVIDER_MAP)
        .filter(([, def]) => def.cliAuthFiles || def.local) // CLI OAuth or local — have dedicated extensions
        .map(([id]) => id)
    );
    // Also skip providers pi knows natively (have built-in models)
    for (const prov of ["anthropic", "openai", "google"]) SKIP_REGISTRATION.add(prov);

    for (const [provId, def] of Object.entries(PROVIDER_MAP)) {
      if (!def.baseUrl || !def.api) continue;
      if (SKIP_REGISTRATION.has(provId)) continue;
      const keys = cfg.providers?.[provId]?.keys;
      if (!keys?.length) continue;
      const rawKey = keys[activeKeyIdx[provId] ?? 0].key;
      const apiKey = resolveKeyValue(rawKey);
      if (!apiKey || apiKey === rawKey && rawKey.startsWith("__local__")) continue;

      // Collect models for this provider from available_models + model_metrics
      const provModels: string[] = [];
      const seen = new Set<string>();
      for (const m of cache.available_models ?? []) {
        if (m.provider === provId && !seen.has(m.id)) { provModels.push(m.id); seen.add(m.id); }
      }
      if (!provModels.length) continue;

      // Skip if provider already has models AND a working API key
      const alreadyRegistered = provModels.some(id => ctx.modelRegistry.find(provId, id));
      if (alreadyRegistered) {
        const existingKey = await ctx.modelRegistry.getApiKeyForProvider(provId).catch(() => null);
        if (existingKey) continue;
      }

      try {
        pi.registerProvider(provId, {
          baseUrl: def.baseUrl,
          apiKey,
          api: def.api,
          models: provModels.map(id => ({
            id,
            name: `${provId}/${id}`,
            reasoning: true,
            input: ["text", "image"] as any,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 64_000,
          })),
        });
      } catch { /* provider already registered or config error */ }
    }

    // Re-register group providers with updated resolution info
    registerGroupProviders();
  }

  // ── Command: /router ───────────────────────────────────────────────────

  pi.registerCommand("router", {
    description: "Model router status. Usage: /router [group|scan|reload]",
    handler: async (args, ctx) => {
      load();
      const arg = args?.trim();
      if (arg === "reload") { load(); loadModelMap(); loadCache(); ctx.ui.notify("Reloaded", "success"); return; }
      if (arg === "scan") { ctx.ui.notify("Scanning...", "info"); await scan(true); ctx.ui.notify(`Done. ${Object.keys(gdpval).length} scores, ${cache.available_models?.length ?? 0} models.`, "success"); return; }
      if (arg === "sync") { load(); registerGroupModels(ctx); ctx.ui.notify("Re-registered group models", "success"); return; }

      if (arg && cfg.model_groups[arg]) {
        const g = cfg.model_groups[arg], res = resolve(arg);
        const desc = g.method === "pipeline" ? `pipeline(${g.pipeline!.map(s => `${s.method}:${s.top_k ?? "∞"}`).join("→")})` : g.method;
        const lines = [`${arg} | ${desc}`, g.description ?? "", ""];
        if (res) res.candidates.forEach((r, i) => lines.push(fmtModel(r, i, i === 0)));
        else lines.push("(no available models)");
        ctx.ui.notify(lines.filter(Boolean).join("\n"), "info"); return;
      }

      // Overview with table
      const lines: string[] = ["Model Router", ""];

      // Group tables with top 5 models (3 available + up to 2 limited)
      for (const [groupName, g] of Object.entries(cfg.model_groups)) {
        const top = getTopModels(groupName, 5);
        const method = g.method === "pipeline"
          ? g.pipeline!.map(s => `${s.method}${s.top_k ? `:${s.top_k}` : ""}`).join(" → ")
          : g.method === "best" ? "best gdpval"
          : g.method === "tiered" ? (g.min_gdpval != null ? `tiered ≥${g.min_gdpval}` : `tiered ≥${g.min_gdpval_pct ?? 0}%`)
          : g.method;
        const active = curModel && allDiscoveredRefs().includes(curModel);
        const activeMarker = active ? " ◀" : "";

        // Group header
        lines.push(`┌─ ${groupName}${activeMarker} `.padEnd(72, "─") + ` ${method} ─`);

        if (top.length === 0) {
          lines.push("│ (no models configured)");
        } else {
          // Compute max model name width (capped at 38)
          const MW = Math.min(38, Math.max(5, ...top.map(t => t.ref.length)));

          // Table header
          lines.push(`│ ${"#".padEnd(3)} ${"Model".padEnd(MW)}  ${"GDP".padStart(4)}  ${"Lat".padStart(5)}  ${"TPS".padStart(4)}  ${"Cost I/O".padStart(11)}  ${"Usage 1d/7d/30d".padStart(15)}  Status`);
          lines.push(`│ ${"─".padEnd(3)} ${"─".repeat(MW)}  ${"────"}  ${"─────"}  ${"────"}  ${"───────────"}  ${"───────────────"}  ──────`);

          for (const { ref, limited, rank } of top) {
            const m = getM(ref);
            const prov = ref.split("/")[0];
            const mux = costMux(prov);
            const cost = effCost(ref);
            const price = lookupPrice(ref);
            const modelShort = ref.length > MW ? "…" + ref.slice(-(MW - 1)) : ref;
            const isActive = curModel === ref;
            const statusParts: string[] = [];
            if (limited) statusParts.push(`⛔${limitSecs(ref)}s`);
            if (mux > 1) statusParts.push(`×${mux}`);
            if (isActive) statusParts.push("●");
            const status = statusParts.join(" ") || (limited ? "" : "active");

            const costDisplay = price
              ? `$${price.input.toFixed(1)}/$${price.output.toFixed(1)}`
              : `$${cost.toFixed(1)}`;

            const u1 = getUsage(ref, 1), u7 = getUsage(ref, 7), u30 = getUsage(ref, 30);
            const usageDisplay = `${fmt(u1)}/${fmt(u7)}/${fmt(u30)}`;

            const sel = rank === 0 ? " ←" : "";
            lines.push(`│ ${String(rank + 1).padEnd(3)} ${modelShort.padEnd(MW)}  ${String(m.gdpval).padStart(4)}  ${String(Math.round(m.avg_latency_ms)).padStart(5)}  ${String(Math.round(m.throughput_tps)).padStart(4)}  ${costDisplay.padStart(11)}  ${usageDisplay.padStart(15)}  ${status}${sel}`);
          }
        }
        lines.push("│");
      }

      // Rate-limited summary
      const rl = [...limits.keys()].filter(r => isLimited(r));
      if (rl.length) {
        lines.push("├─ Rate Limited ".padEnd(72, "─"));
        for (const r of rl) {
          const { provider, modelId } = splitRef(r);
          lines.push(`│ ⛔ ${provider}/${modelId} (${limitSecs(r)}s remaining)`);
        }
      }

      lines.push("└" + "─".repeat(71));
      lines.push("", "/router <group> | scan | reload | sync");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
