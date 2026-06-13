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
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  Context,
  SimpleStreamOptions,
  AssistantMessageEventStream,
} from '@mariozechner/pi-ai';
import {
  streamSimple as piStreamSimple,
  createAssistantMessageEventStream,
} from '@mariozechner/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { truncateToWidth } from '@mariozechner/pi-tui';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import type { Config, Cache, Metrics, Defaults } from './src/types.ts';
import { PROVIDER_MAP, SKIP_REGISTRATION } from './src/providers.ts';
import { splitRef, stripDateSuffix } from './src/utils.ts';
import { RateLimitManager } from './src/rate-limit.ts';
import { DiscoveryManager } from './src/discovery.ts';
import * as metricsModule from './src/metrics.ts';
import { CacheManager } from './src/cache.ts';
import { Router } from './src/routing.ts';
import { classifyPrompt, getGroupForCategory } from './src/content-classifier.ts';

function loadDefaults(extDir: string): Defaults {
  const yamlPath = path.join(extDir, 'router-defaults.yaml');
  return YAML.parse(fs.readFileSync(yamlPath, 'utf-8')) as Defaults;
}

const _defaults = loadDefaults(path.dirname(fileURLToPath(import.meta.url)));
const BACKOFF = _defaults.backoff_minutes.map((m) => m * 60_000);
const SOFT_BACKOFF = _defaults.soft_backoff_ms;
const COST_MUX_AT_HIT = _defaults.cost_mux_at_hit;
const MODELS_TTL = _defaults.models_ttl_ms;
const MAX_STREAM_RETRIES = _defaults.max_stream_retries;
const EMPTY_RESPONSE_TIMEOUT_MS = _defaults.empty_response_timeout_ms;
const GDPVAL_URL = _defaults.gdpval_url;

// ── Extension ──────────────────────────────────────────────────────────────

const defaultExport = function (pi: ExtensionAPI) {
  const extDir = path.dirname(fileURLToPath(import.meta.url));
  const cfgPath = path.join(extDir, 'router-config.json');

  const STRIP_SUFFIXES = _defaults.strip_suffixes;
  let cfg: Config;
  let cache: Cache = {};
  let rateLimitManager: RateLimitManager;
  let discoveryManager: DiscoveryManager;
  let cacheManager: CacheManager;
  let router: Router;
  let gdpval: Record<string, number> = {};
  let scanning = false;
  let sessionStart = Date.now();
  let turnStart = 0;
  let curModel = '';
  let activeGroup: string | null = null;
  let lastDynamicModel = '';
  let sessionCtx: any = null;

  // ── Helpers ────────────────────────────────────────────────────────────

  function norm(s: string): string {
    s = s.toLowerCase();
    // Strip to last path segment — "chutes/deepseek-ai/DeepSeek-V3" → "deepseek-v3"
    const slash = s.lastIndexOf('/');
    if (slash !== -1 && slash < s.length - 1) s = s.slice(slash + 1);
    for (const x of STRIP_SUFFIXES) s = s.replace(x, '');
    s = stripDateSuffix(s);
    return s.replace(/[^a-z0-9]/g, '');
  }

  // ── Model Map: authoritative model → GDPval slug mapping ────────────

  // Load model-map.yaml: maps "modelId" → "gdpval-slug" (or null)
  type ModelMap = Record<string, string | null>;
  let modelMap: ModelMap = {};
  let modelMapWildcards: [string, string | null][] = []; // [prefix, slug]

  function loadModelMap() {
    const mapPath = path.join(extDir, 'model-map.yaml');
    try {
      const raw = YAML.parse(fs.readFileSync(mapPath, 'utf-8')) as Record<string, string | null>;
      modelMap = {};
      modelMapWildcards = [];
      for (const [key, slug] of Object.entries(raw)) {
        if (key === null || typeof key !== 'string') continue;
        if (key.endsWith('*')) {
          modelMapWildcards.push([key.slice(0, -1), slug]);
        } else {
          modelMap[key] = slug;
        }
      }
      // Sort wildcards longest-first for most specific match
      modelMapWildcards.sort((a, b) => b[0].length - a[0].length);
    } catch {
      /* no map file, use fallback only */
    }
  }

  /** Strip provider prefix from ref: "chutes/deepseek-ai/DeepSeek-V3" → "deepseek-ai/DeepSeek-V3" */
  function stripProvider(ref: string): string {
    const i = ref.indexOf('/');
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
  const PARAM_SUFFIXES = [
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

  /** Extract base model tokens: strip params, suffixes, dates, then split to sorted token set */
  function baseTokens(s: string): Set<string> {
    s = s.toLowerCase();
    const slash = s.lastIndexOf('/');
    if (slash !== -1 && slash < s.length - 1) s = s.slice(slash + 1);
    for (const ps of PARAM_SUFFIXES) s = s.replace(ps, '');
    for (const x of STRIP_SUFFIXES) s = s.replace(x, '');
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
      const key = [...baseTokens(slug)].sort().join('|');
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
      const key = [...baseTokens(mapped)].sort().join('|');
      return gdpvalIndex!.get(key) ?? null;
    }
    // Fallback: automatic token-set matching
    if (lastIndexVersion !== gdpvalVersion) buildGdpvalIndex();
    const key = [...baseTokens(id)].sort().join('|');
    return gdpvalIndex!.get(key) ?? null;
  }

  function fmt(n: number) {
    return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
  }

  function fmtTime(ms: number) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60),
      rs = s % 60;
    if (m < 60) return `${m}m${rs ? rs + 's' : ''}`;
    return `${Math.floor(m / 60)}h${m % 60 ? (m % 60) + 'm' : ''}`;
  }

  // ── Config + Cache ─────────────────────────────────────────────────────

  function load() {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    if (cfg.gdpval_builtin) {
      Object.assign(gdpval, cfg.gdpval_builtin);
      gdpvalVersion++;
    }
    // Initialize managers
    rateLimitManager = new RateLimitManager(BACKOFF, SOFT_BACKOFF, COST_MUX_AT_HIT, cache);
    discoveryManager = new DiscoveryManager(cfg, cache);
    metricsModule.setConfig(cfg);
    cacheManager = new CacheManager(extDir);
    router = new Router(cfg, cache, rateLimitManager.getLimits());
    metricsModule.setCache(cache);
  }

  function loadCache() {
    cache = cacheManager.loadCache();
    metricsModule.setCache(cache);
  }

  function saveCache() {
    cacheManager.saveCache(cache);
  }

  // ── Key Discovery ───────────────────────────────────────────────────────

  async function discoverKeys() {
    await discoveryManager.discoverKeys();
    cache = discoveryManager.getCache();
  }

  // ── Scan (GDPval forever, models 24hr) ─────────────────────────────────

  async function fetchJson(
    url: string,
    opts?: { headers?: Record<string, string>; timeoutMs?: number }
  ): Promise<any> {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'pi-model-router/1.0', ...opts?.headers },
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
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(30_000),
          });
          const html = await res.text().then((h) => h.replace(/\\"/g, '"'));
          // Extract slug → name mapping from JSON data embedded in page
          const slugMap: Record<string, string> = {};
          const slugRe = /"([a-z0-9][a-z0-9._-]+)","name":"([^"]+)","shortName":"([^"]+)"/g;
          let sm;
          while ((sm = slugRe.exec(html))) {
            if (sm[2]) {
              slugMap[sm[2]] = sm[1];
              if (sm[3] && sm[3] !== sm[2]) slugMap[sm[3]] = sm[1];
            }
          }
          // Extract name → score from HTML table
          const tableRe = /<div[^>]*>([^<]{3,80})<\/div><\/td>\s*<td[^>]*>(\d{3,4})<\/td>/g;
          let m;
          const scores: Record<string, number> = {};
          while ((m = tableRe.exec(html))) {
            const nm = m[1]
              .trim()
              .replace(/&#x27;/g, "'")
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"');
            if (!nm || !/[A-Za-z]/.test(nm) || nm.startsWith('<')) continue;
            const score = +m[2];
            // Prefer slug key (machine-readable) over display name
            const slug = slugMap[nm];
            const key = slug ?? nm;
            if (!scores[key] || score > scores[key]) scores[key] = score;
          }
          if (Object.keys(scores).length) {
            gdpval = { ...scores };
            gdpvalVersion++;
            cache.gdpval_scores = gdpval;
            cache.gdpval_scraped = true;
          }
        } catch {
          /* scrape failed, use builtins */
        }
      }
      const age = cache.models_cached
        ? Date.now() - new Date(cache.models_cached).getTime()
        : Infinity;
      // Also rescan if any configured provider has keys but zero models cached
      const missingProviders = Object.entries(cfg.providers ?? {}).some(
        ([p, pc]) =>
          pc.keys?.length && !(cache.available_models ?? []).some((m) => m.provider === p)
      );
      if (force || age > MODELS_TTL || missingProviders) {
        const models: Cache['available_models'] = [];
        if (cfg.providers?.chutes?.keys?.length) {
          try {
            const d = await fetchJson('https://llm.chutes.ai/v1/models');
            const pricing = cache.openrouter_pricing ?? {};
            for (const m of d.data ?? []) {
              models.push({ id: m.id, provider: 'chutes', cost_per_m: m.pricing?.prompt ?? 0 });
              const inp = m.pricing?.prompt ?? 0;
              const out = m.pricing?.completion ?? 0;
              if (inp >= 0 && out >= 0) {
                const ref = `chutes/${m.id}`;
                if (!pricing[ref] || inp < pricing[ref].input)
                  pricing[ref] = { input: inp, output: out };
              }
            }
            cache.openrouter_pricing = pricing;
          } catch {}
        }
        if (cfg.providers?.openrouter?.keys?.length) {
          try {
            const d = await fetchJson('https://openrouter.ai/api/v1/models', { timeoutMs: 25_000 });
            const pricing: Record<string, { input: number; output: number }> =
              cache.openrouter_pricing ?? {};
            for (const m of d.data ?? []) {
              if (String(m.pricing?.prompt ?? '1') === '0')
                models.push({ id: m.id, provider: 'openrouter', cost_per_m: 0 });
              const inp = parseFloat(m.pricing?.prompt ?? '0') * 1_000_000;
              const out = parseFloat(m.pricing?.completion ?? '0') * 1_000_000;
              if (inp >= 0 && out >= 0) {
                const ref = `openrouter/${m.id}`;
                pricing[ref] = { input: inp, output: out };
                if (m.id.includes('/') && inp > 0) {
                  if (!pricing[m.id] || inp < pricing[m.id].input)
                    pricing[m.id] = { input: inp, output: out };
                }
              }
            }
            cache.openrouter_pricing = pricing;
          } catch {}
        }
        try {
          const d = await fetchJson('http://localhost:11434/api/tags', { timeoutMs: 5_000 });
          for (const m of d.models ?? []) {
            const id = m.name;
            if (!id) continue;
            const existing = models.find((x) => x.provider === 'ollama' && x.id === id);
            if (!existing) models.push({ id, provider: 'ollama', cost_per_m: 0 });
          }
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
                  const id = m.id ?? m.name?.replace(/^models\//, '');
                  if (!id) continue;
                  if (
                    /embed|tts|whisper|dall|moderation|babbage|davinci|search|audio|realtime|image|transcri/i.test(
                      id
                    )
                  )
                    continue;
                  const existing = models.find((x) => x.provider === provId && x.id === id);
                  if (!existing) models.push({ id, provider: provId, cost_per_m: 0 });
                }
                break; // success, stop trying keys
              } catch {
                /* try next key */
              }
            }
          });
        await Promise.allSettled(providerScans);
        if (models.length) {
          // Merge: keep existing entries for providers not scanned (or whose scan failed)
          const scannedProviders = new Set(models.map((m) => m.provider));
          const kept = (cache.available_models ?? []).filter(
            (m) => !scannedProviders.has(m.provider)
          );
          cache.available_models = [...kept, ...models];
          cache.models_cached = new Date().toISOString();
        }
      }
      saveCache();
    } finally {
      scanning = false;
    }
  }

  // ── Metrics ────────────────────────────────────────────────────────────

  function getM(ref: string): Metrics {
    return metricsModule.getM(ref);
  }

  function updateMetrics(ref: string, latMs: number, tokens: number, durMs: number) {
    metricsModule.updateMetrics(ref, latMs, tokens, durMs);
  }

  // ── Rate Limit + costMux ───────────────────────────────────────────────

  let activeKeyIdx: Record<string, number> = {}; // provider → current key index

  function resolveKeyValue(key: string): string {
    return discoveryManager.resolveKeyValue(key) ?? key;
  }

  /** Try rotating to next available key for provider. Returns true if switched. */

  function costMux(prov: string) {
    return rateLimitManager.costMux(prov);
  }

  function isLimited(ref: string) {
    return rateLimitManager.isLimited(ref);
  }

  function recordLimit(ref: string): { rotated: boolean; newKey?: string } {
    return rateLimitManager.recordLimit(ref, cfg.providers ?? {});
  }

  function recordOk(ref: string) {
    rateLimitManager.recordOk(ref);
  }

  /** Record a soft failure (empty response, timeout) — lighter backoff than 429 */
  function recordSoftFailure(ref: string): void {
    rateLimitManager.recordSoftFailure(ref);
  }

  function limitSecs(ref: string) {
    return rateLimitManager.limitSecs(ref);
  }

  // ── Usage Stats ────────────────────────────────────────────────────────

  function getUsage(ref: string, days: number): number {
    return metricsModule.getUsage(ref, days);
  }

  // ── Price lookup (OpenRouter as oracle) ─────────────────────────────────

  function lookupPrice(ref: string): { input: number; output: number } | null {
    return metricsModule.lookupPrice(ref);
  }

  // ── Effective cost ─────────────────────────────────────────────────────

  function effCost(ref: string): number {
    return metricsModule.effCost(ref);
  }

  // ── Resolution ─────────────────────────────────────────────────────────

  // ── Auto-discovery ────────────────────────────────────────────────────

  /** All known model refs: auto-discovered + any pinned models in group config */
  function allDiscoveredRefs(): string[] {
    return router.allDiscoveredRefs();
  }

  /** Get billing tier for a model ref: 0=free, 1=subscription, 2=local, 3=payg */

  /** Check provider key health: "valid" if key exists and not exhausted, "exhausted" if all keys spent, "unchecked" if no keys configured */
  function providerKeyHealth(prov: string): 'valid' | 'exhausted' | 'unchecked' {
    return discoveryManager.providerKeyHealth(prov, cache.exhausted_keys);
  }

  /** Filter to available models (not rate-limited, healthy provider keys) */
  /** Filter by minimum gdpval percentile (0-100). Keeps models at or above the percentile threshold. */
  /** Filter by absolute minimum gdpval score. Falls back to all refs if none qualify. */
  /**
   * Sort by billing preference: free → subscription (by rate-limit pressure & cost) → local → PAYG (by cost)
   * Within each tier, sort by effective cost. Subscription also considers rate-limit pressure.
   */

  function resolve(name: string): { selected: string; candidates: string[] } | null {
    return router.resolve(name);
  }

  // ── Format ─────────────────────────────────────────────────────────────

  function fmtModel(ref: string, i: number, sel: boolean) {
    const m = getM(ref),
      prov = ref.split('/')[0],
      mux = costMux(prov);
    const billing =
      cfg.providers?.[prov]?.billing === 'subscription'
        ? 'sub'
        : m.cost_per_m === 0
          ? 'free'
          : 'ppt';
    const muxS = mux > 1 ? ` ×${mux}` : '';
    const rl = isLimited(ref) ? ` ⛔${limitSecs(ref)}s` : '';
    return `${i + 1}. ${ref}  gdp:${m.gdpval}  tps:${Math.round(m.throughput_tps)}  eff:$${effCost(ref).toFixed(3)}/M  [${billing}${muxS}]${rl}${sel ? ' ←' : ''}`;
  }

  // Get top N models for a group, including rate-limited ones (for display)
  function getTopModels(
    groupName: string,
    n: number
  ): { ref: string; limited: boolean; rank: number }[] {
    return router.getTopModels(groupName, n);
  }

  function detectGroup(ref: string): string | null {
    return router.detectGroup(ref);
  }

  /**
   * Register virtual providers for each model group (strategic, tactical, etc).
   * Called synchronously during extension load so groups are available for
   * --model resolution before session_start fires.
   */
  function registerGroupProviders() {
    for (const [groupName] of Object.entries(cfg.model_groups)) {
      const res = resolve(groupName);
      const resolvedRef = res?.selected ?? 'none';
      const resolvedMetrics = res ? getM(resolvedRef) : null;

      (pi as any).registerProvider(groupName, {
        baseUrl: 'https://router.local', // not used — streamSimple overrides
        apiKey: 'router-virtual', // not used — streamSimple overrides
        api: `router-group-${groupName}`, // unique per group to avoid overwriting global API providers
        streamSimple: groupStream,
        models: [
          {
            id: groupName,
            name: `${groupName} → ${resolvedRef}`,
            reasoning: true,
            input: ['text', 'image'] as any,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: resolvedMetrics ? 200_000 : 128_000,
            maxTokens: 64_000,
          },
          ...(cfg.model_groups[groupName]?.method === 'dynamic' ? [{
            id: `${groupName}:use-static`,
            name: `${groupName} → ${resolvedRef} (static fallback)`,
            reasoning: true,
            input: ['text', 'image'] as any,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: resolvedMetrics ? 200_000 : 128_000,
            maxTokens: 64_000,
          }] : []),
        ],
      });
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────

  load();
  loadModelMap();
  loadCache();
  registerGroupProviders();

  pi.on('session_start', async (_ev, ctx) => {
    sessionCtx = ctx;
    router.setSessionCtx(ctx);
    load();
    loadModelMap();
    loadCache();
    sessionStart = Date.now();
    await discoverKeys();

    await registerGroupModels(ctx);
    scan().catch(() => {});

    // Footer
    ctx.ui.setFooter((tui, theme, fd) => {
      const unsub = fd.onBranchChange(() => tui.requestRender());
      const timer = setInterval(() => tui.requestRender(), 30000);
      return {
        dispose() {
          unsub();
          clearInterval(timer);
        },
        invalidate() {},
        render(w: number): string[] {
          const ref = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '';
          const grp = ref ? detectGroup(ref) : null;
          const isDynamic = ctx.model?.id === 'dynamic';
          const m = ref ? getM(isDynamic && lastDynamicModel ? lastDynamicModel : ref) : null;
          const modelDisplay =
            isDynamic && lastDynamicModel
              ? `dynamic→${lastDynamicModel}`
              : `${ctx.model?.provider ?? '?'}/${ctx.model?.id ?? '?'}`;
          const rStr = theme.fg('accent', `${grp ?? '—'}/${modelDisplay}`);
          const iStr = m ? theme.fg('warning', `int:${m.gdpval}`) : '';
          const tStr = m ? theme.fg('success', `tps:${Math.round(m.throughput_tps)}`) : '';

          let inp = 0,
            out = 0,
            cost = 0;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === 'message' && e.message.role === 'assistant') {
              const a = e.message as AssistantMessage;
              inp += a.usage.input;
              out += a.usage.output;
              cost += a.usage.cost.total;
            }
          }
          const u = ctx.getContextUsage(),
            pct = u?.percent ?? 0;
          const pCol = pct > 75 ? 'error' : pct > 50 ? 'warning' : 'success';
          const tok = [
            theme.fg('accent', `${fmt(inp)}/${fmt(out)}`),
            theme.fg('warning', `$${cost.toFixed(2)}`),
            theme.fg(pCol, `${pct.toFixed(0)}%`),
          ].join(' ');
          const el = theme.fg('dim', `⏱${fmtTime(Date.now() - sessionStart)}`);
          const pp = process.cwd().split('/');
          const cwd = theme.fg(
            'muted',
            `⌂ ${pp.length > 2 ? pp.slice(-2).join('/') : process.cwd()}`
          );
          const br = fd.getGitBranch();
          const brS = br ? theme.fg('accent', `⎇ ${br}`) : '';
          const rlN = [...rateLimitManager.getLimits().keys()].filter((r) => isLimited(r)).length;
          const rlS = rlN > 0 ? theme.fg('error', `⛔${rlN}`) : '';

          const sep = theme.fg('dim', ' | ');
          const parts = [rStr];
          if (iStr && tStr) parts.push(`${iStr} ${tStr}`);
          parts.push(tok, el, cwd);
          if (brS) parts.push(brS);
          if (rlS) parts.push(rlS);
          return [truncateToWidth(parts.join(sep), w)];
        },
      };
    });
  });

  pi.on('session_switch', async (ev) => {
    if (ev.reason === 'new') sessionStart = Date.now();
  });
  pi.on('model_select', async (ev) => {
    if (ev.source !== 'restore') activeGroup = null;
    curModel = `${ev.model.provider}/${ev.model.id}`;
  });
  pi.on('turn_start', async (_ev, ctx) => {
    turnStart = Date.now();
    if (ctx.model) curModel = `${ctx.model.provider}/${ctx.model.id}`;
  });

  pi.on('turn_end', async (ev) => {
    if (!curModel || !turnStart) return;
    const ms = Date.now() - turnStart,
      msg = ev.message;
    if (msg?.role === 'assistant') {
      const txt =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content ?? [])
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('');
      const tok = Math.ceil(txt.length / 4);
      if (tok > 0) {
        updateMetrics(curModel, ms, tok, ms);
        recordOk(curModel);
        // Log usage
        if (!cache.usage_log) cache.usage_log = [];
        cache.usage_log.push({ ref: curModel, tokens: tok, ts: Date.now() });
        // Trim log to last 30 days
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        cache.usage_log = cache.usage_log.filter((e) => e.ts > cutoff);
      }
    }
  });

  pi.on('tool_result', async (ev, ctx) => {
    if (ev.isError && curModel) {
      const txt = ev.content?.map((c: any) => c.text ?? '').join('') ?? '';
      if (txt.includes('429') || txt.toLowerCase().includes('rate limit')) {
        const result = recordLimit(curModel);
        if (result.rotated) {
          ctx.ui.notify(
            `🔑 Rate limited — rotated ${splitRef(curModel).provider} to key "${result.newKey}"`,
            'warning'
          );
        }
      }
    }
  });

  let turns = 0;
  pi.on('turn_end', async () => {
    if (++turns % 10 === 0) saveCache();
  });
  pi.on('session_shutdown', async () => saveCache());

  // ── Tools ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'set_model_from_group',
    label: 'Set Model from Group',
    description:
      'Resolve a model group and immediately switch the current session to use the selected model. Combines resolve_model_group + model switch in one step.',
    parameters: Type.Object({ group: Type.String({ description: 'Model group name' }) }) as any,
    async execute(
      _id: string,
      params: { group: string },
      _onUpdate: unknown,
      ctx: ExtensionContext
    ) {
      load();
      const name = params.group.toLowerCase(),
        res = resolve(name);
      if (!res)
        throw new Error(
          `No models for group "${params.group}". Available: ${Object.keys(cfg.model_groups).join(', ')}`
        );
      for (const ref of res.candidates) {
        const { provider, modelId } = splitRef(ref);
        const model = ctx.modelRegistry.find(provider, modelId);
        if (model && (await pi.setModel(model))) {
          activeGroup = name;
          const m = getM(ref);
          return {
            content: [
              {
                type: 'text',
                text: `${ref} (${name}, gdp:${m.gdpval}, tps:${Math.round(m.throughput_tps)})`,
              },
            ],
            details: { group: name, selected: ref, provider, modelId },
          };
        }
      }
      throw new Error(`No available model in "${name}". Tried: ${res.candidates.join(', ')}`);
    },
  });

  pi.registerTool({
    name: 'resolve_model_group',
    label: 'Resolve Model Group',
    description:
      'Resolve a model group name (strategic, tactical, operational, scout, fallback) to a concrete provider/model. Use this when you need to select a model for a subagent or task and want the router to pick the best one.',
    parameters: Type.Object({
      group: Type.String({
        description:
          'Model group name: strategic, tactical, operational, scout, fallback, or any custom group',
      }),
    }) as any,
    async execute(_id: string, params: { group: string }, _onUpdate: unknown, _ctx: ExtensionContext) {
      load();
      const name = params.group.toLowerCase(),
        res = resolve(name);
      if (!res)
        throw new Error(
          `Unknown or empty group "${params.group}". Available: ${Object.keys(cfg.model_groups).join(', ')}`
        );
      const { provider, modelId } = splitRef(res.selected);
      const table = res.candidates.map((r, i) => fmtModel(r, i, i === 0)).join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `"${name}" (${cfg.model_groups[name].method}) → ${res.selected}\n\n${table}`,
          },
        ],
        details: {
          group: name,
          selected: res.selected,
          provider,
          modelId,
          candidates: res.candidates,
        },
      };
    },
  });

  pi.registerTool({
    name: 'update_model_metrics',
    label: 'Update Model Metrics',
    description:
      'Update runtime metrics (gdpval, throughput, latency) for a model in the router config.',
    parameters: Type.Object({
      model_ref: Type.String({ description: 'Model reference (provider/model-id)' }),
      gdpval: Type.Optional(Type.Number()),
      throughput_tps: Type.Optional(Type.Number()),
      avg_latency_ms: Type.Optional(Type.Number()),
    }) as any,
    async execute(_id: string, p: { model_ref: string; gdpval?: number; throughput_tps?: number; avg_latency_ms?: number }, _onUpdate: unknown, _ctx: ExtensionContext) {
      load();
      const e = cfg.model_metrics[p.model_ref] ?? {};
      if (p.gdpval !== undefined) e.gdpval = p.gdpval;
      if (p.throughput_tps !== undefined) e.throughput_tps = p.throughput_tps;
      if (p.avg_latency_ms !== undefined) e.avg_latency_ms = p.avg_latency_ms;
      cfg.model_metrics[p.model_ref] = e;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      // Update metrics cache with new values from config
      const existingMetrics = metricsModule.getM(p.model_ref);
      if (existingMetrics) {
        Object.assign(existingMetrics, e, { last_updated: Date.now() });
      }
      return {
        content: [{ type: 'text', text: `Updated ${p.model_ref}: ${JSON.stringify(e)}` }],
        details: { model_ref: p.model_ref, metrics: e },
      };
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
    options: SimpleStreamOptions | undefined
  ): Promise<{ stream: AssistantMessageEventStream; ref: string } | null> {
    if (!sessionCtx) return null;
    const { provider, modelId } = splitRef(ref);
    // Skip group virtual models to prevent recursion
    if (cfg.model_groups[provider]) return null;
    const realModel = sessionCtx.modelRegistry.find(provider, modelId);
    if (!realModel) return null;
    if (cfg.model_groups[realModel.provider]) return null;
    const apiKey = await sessionCtx.modelRegistry
      .getApiKeyForProvider(realModel.provider)
      .catch(() => null);
    const isLocal = (PROVIDER_MAP as any)[realModel.provider]?.local ?? false;
    if (!apiKey && !isLocal) return null;
    // Strip the group's virtual apiKey from options — it must not reach the real provider
    const { apiKey: _drop, ...baseOpts } = options ?? {};
    const streamOpts = apiKey ? { ...baseOpts, apiKey } : baseOpts;
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
    timeoutMs: number
  ): Promise<{ ok: boolean; reason?: string }> {
    let hadContent = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    // Start a timeout that fires if we never see content
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve('timeout');
      }, timeoutMs);
    });

    // Race: iterate the stream vs timeout
    const iterPromise = (async (): Promise<'done'> => {
      try {
        for await (const event of upstream) {
          // Cancel timeout on first real content
          if (!hadContent) {
            const t = event.type;
            if (
              t === 'text_delta' ||
              t === 'thinking_delta' ||
              t === 'toolcall_start' ||
              t === 'toolcall_delta'
            ) {
              hadContent = true;
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
            }
          }
          proxy.push(event);
          if (event.type === 'error') {
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            return 'done';
          }
        }
      } catch (err) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        // Stream threw — treat as soft failure
        return 'done';
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return 'done';
    })();

    const winner = await Promise.race([iterPromise, timeoutPromise]);

    if (winner === 'timeout' && !hadContent) {
      // No content within timeout — soft failure
      return { ok: false, reason: 'empty_timeout' };
    }

    // Stream completed — check if we actually got content
    if (!hadContent) {
      return { ok: false, reason: 'empty_response' };
    }

    return { ok: true };
  }

  /**
   * Stream with automatic retry on soft failures (empty responses, timeouts).
   * Creates a proxy AssistantMessageEventStream that consumers iterate.
   * On failure, records the model as soft-limited and tries the next candidate.
   */
  function extractLastUserPrompt(context: Context): string {
    try {
      const userMsgs = context.messages.filter((m) => m.role === 'user');
      const last = userMsgs[userMsgs.length - 1];
      if (!last) return '';
      const c = last.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c))
        return c
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('');
    } catch {
      /* context shape unknown */
    }
    return '';
  }

  function groupStream(
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream {
    const useStaticMatch = model.id.match(/^(.+):use-static$/);
    const useStatic = useStaticMatch !== null;
    const groupName = useStaticMatch ? useStaticMatch[1] : model.id;
    const g = cfg.model_groups[groupName];
    const isDynamic = g?.method === 'dynamic';

    if (!isDynamic) {
      const res = resolve(groupName);
      if (!res) throw new Error(`No available models for group "${groupName}"`);
      // fall through with res below
      const proxy = createAssistantMessageEventStream();
      const candidates = [...res.candidates];
      driveStream(proxy, candidates, context, options);
      return proxy;
    }

    // Dynamic group: classify the prompt first, then stream from the resolved group
    const proxy = createAssistantMessageEventStream();
    (async () => {
      let candidates: string[];
      let dynamicLabel: string | undefined;
      try {
        // If the last message is a tool result, we're mid-conversation — reuse the same
        // model to avoid "unmatched tool result" errors from pi's bridge
        const lastMsg = context.messages[context.messages.length - 1];
        const isToolFollowUp = lastMsg?.role === 'toolResult' && !!lastDynamicModel;
        if (isToolFollowUp) {
          const res =
            resolve('fallback') ??
            resolve(
              Object.keys(cfg.model_groups).find((k) => cfg.model_groups[k].method !== 'dynamic')!
            );
          if (!res) throw new Error('No fallback model for tool follow-up');
          // Prefer the exact model used in the previous turn
          candidates = [lastDynamicModel, ...res.candidates.filter((r) => r !== lastDynamicModel)];
          await driveStream(proxy, candidates, context, options);
          return;
        }

        const prompt = extractLastUserPrompt(context);
        
        // HINT-Override: User kann Modell/Gruppe direkt im Prompt angeben
        const hintMatch = prompt.match(/HINT:\s*(?:use\s+)?(?:(?:model|group)\s+)?([a-zA-Z0-9\-_:/.]+)/i);
        if (hintMatch) {
          const hintTarget = hintMatch[1];
          // Prüfe ob es eine Gruppe ist
          if (cfg.model_groups[hintTarget]) {
            const res = resolve(hintTarget);
            if (res) {
              candidates = [...res.candidates];
              lastDynamicModel = res.selected;
              dynamicLabel = `HINT: ${hintTarget} → ${res.selected}`;
              const logLine = `${new Date().toISOString()}  ${dynamicLabel}  "${prompt.slice(0, 80).replace(/\n/g, ' ')}"`;
              console.log(`[dynamic] ${logLine}`);
              try {
                fs.appendFileSync(path.join(homedir(), '.pi', 'logs', 'router.log'), logLine + '\n');
              } catch {}
              await driveStream(proxy, candidates, context, options, dynamicLabel);
              return;
            }
          }
          // Prüfe ob es ein Modell-Ref ist (provider/model-id) - direkt verwenden
          // Einfache Validierung: muss '/' enthalten für provider/model
          if (hintTarget.includes('/')) {
            candidates = [hintTarget];
            lastDynamicModel = hintTarget;
            dynamicLabel = `HINT: ${hintTarget}`;
            const logLine = `${new Date().toISOString()}  ${dynamicLabel}  "${prompt.slice(0, 80).replace(/\n/g, ' ')}"`;
            console.log(`[dynamic] ${logLine}`);
            try {
              fs.appendFileSync(path.join(homedir(), '.pi', 'logs', 'router.log'), logLine + '\n');
            } catch {}
            await driveStream(proxy, candidates, context, options, dynamicLabel);
            return;
          }
          console.warn(`[dynamic] HINT target not found: ${hintTarget}`);
        }
        
        const { category } = await classifyPrompt(prompt, { allowStaticFallback: useStatic });
        const targetGroup = getGroupForCategory(category);
        const res = resolve(targetGroup) ?? resolve('fallback');
        if (!res) throw new Error(`No models for dynamic target "${targetGroup}"`);
        candidates = [...res.candidates];
        lastDynamicModel = res.selected;
        dynamicLabel = `${category} → ${targetGroup}`;
        const logLine = `${new Date().toISOString()}  ${dynamicLabel}  ${res.selected}  "${prompt.slice(0, 80).replace(/\n/g, ' ')}"`;
        console.log(`[dynamic] ${logLine}`);
        try {
          fs.appendFileSync(path.join(homedir(), '.pi', 'logs', 'router.log'), logLine + '\n');
        } catch {}
      } catch (err) {
        console.error('[dynamic] classification failed, using fallback:', err);
        const fb =
          resolve('fallback') ??
          resolve(
            Object.keys(cfg.model_groups).find((k) => cfg.model_groups[k].method !== 'dynamic')!
          );
        if (!fb) {
          proxy.push({
            type: 'error',
            reason: 'error',
            error: {
              role: 'assistant',
              content: [{ type: 'text', text: `[router] Dynamic routing failed: ${err}` }],
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: 'error',
              timestamp: Date.now(),
            } as AssistantMessage,
          } as AssistantMessageEvent);
          return;
        }
        candidates = [...fb.candidates];
      }
      await driveStream(proxy, candidates, context, options, dynamicLabel);
    })();
    return proxy;
  }

  function driveStream(
    proxy: AssistantMessageEventStream,
    candidates: string[],
    context: Context,
    options: SimpleStreamOptions | undefined,
    label?: string
  ): Promise<void> {
    return (async () => {
      let lastError: string | undefined;

      for (let attempt = 0; attempt <= MAX_STREAM_RETRIES && candidates.length > 0; attempt++) {
        // Pick next available candidate (skip any that became limited between attempts)
        let target: { stream: AssistantMessageEventStream; ref: string } | null = null;
        let targetRef: string | undefined;

        while (candidates.length > 0) {
          const ref = candidates.shift()!;
          if (isLimited(ref)) continue;
          target = await tryStream(ref, context, options);
          if (target) {
            targetRef = ref;
            break;
          }
        }

        if (!target || !targetRef) break;

        // Show which model is actually used (may differ from initially selected after retries)
        const prefix = label ? `${label} · ${targetRef}` : targetRef;
        proxy.push({ type: 'text_delta', text: `> [router] ${prefix}\n\n` } as any);

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

        // Notify the user about the empty response
        const reason = result.reason === 'empty_timeout'
          ? 'keine Antwort innerhalb des Timeouts'
          : 'leere Antwort vom Modell';
        if (candidates.length > 0 && attempt < MAX_STREAM_RETRIES) {
          const nextRef = candidates[0];
          proxy.push({
            type: 'text_delta',
            text: `> [router] ${targetRef} — ${reason}, versuche ${nextRef} …\n\n`,
          } as any);
        } else {
          proxy.push({
            type: 'text_delta',
            text: `> [router] ${targetRef} — ${reason}\n\n`,
          } as any);
        }
      }

      // All retries exhausted — push an error event
      const errMsg: AssistantMessage = {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `[router] All candidates failed. Last: ${lastError ?? 'no candidates'}`,
          },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error',
        timestamp: Date.now(),
      } as AssistantMessage;
      proxy.push({ type: 'error', reason: 'error', error: errMsg } as AssistantMessageEvent);
    })().catch((err) => {
      // Unhandled error in the async driver — surface it
      const errMsg: AssistantMessage = {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `[router] Stream error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error',
        timestamp: Date.now(),
      } as AssistantMessage;
      proxy.push({ type: 'error', reason: 'error', error: errMsg } as AssistantMessageEvent);
    });
  }

  async function registerGroupModels(ctx: any) {
    // Register discovered providers with pi's model registry.
    // Skip providers that have dedicated extensions (CLI OAuth), built-in pi support,
    // or are already registered by another extension.
    // Also skip providers pi knows natively (have built-in models)
    for (const prov of ['anthropic', 'openai', 'google']) SKIP_REGISTRATION.add(prov);

    for (const [provId, def] of Object.entries(PROVIDER_MAP)) {
      if (!def.baseUrl || !def.api) continue;
      if (SKIP_REGISTRATION.has(provId)) continue;
      const keys = cfg.providers?.[provId]?.keys;
      if (!keys?.length) continue;
      const rawKey = keys[activeKeyIdx[provId] ?? 0].key;
      const apiKey = resolveKeyValue(rawKey);
      if (!apiKey || (apiKey === rawKey && rawKey.startsWith('__local__'))) continue;

      // Collect models for this provider from available_models + model_metrics
      const provModels: string[] = [];
      const seen = new Set<string>();
      for (const m of cache.available_models ?? []) {
        if (m.provider === provId && !seen.has(m.id)) {
          provModels.push(m.id);
          seen.add(m.id);
        }
      }
      if (!provModels.length) continue;

      // Skip if provider already has models AND a working API key
      const alreadyRegistered = provModels.some((id) => ctx.modelRegistry.find(provId, id));
      if (alreadyRegistered) {
        const existingKey = await ctx.modelRegistry.getApiKeyForProvider(provId).catch(() => null);
        if (existingKey) continue;
      }

      try {
        (pi as any).registerProvider(provId, {
          baseUrl: def.baseUrl,
          apiKey,
          api: def.api,
          models: provModels.map((id) => ({
            id,
            name: `${provId}/${id}`,
            reasoning: true,
            input: ['text', 'image'] as any,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 64_000,
          })),
        });
      } catch {
        /* provider already registered or config error */
      }
    }

    // Re-register group providers with updated resolution info
    registerGroupProviders();
  }

  // ── Command: /router ───────────────────────────────────────────────────

  pi.registerCommand('router', {
    description: 'Model router status. Usage: /router [group|scan|reload]',
    handler: async (args, ctx) => {
      load();
      const arg = args?.trim();
      if (arg === 'reload') {
        load();
        loadModelMap();
        loadCache();
        ctx.ui.notify('Reloaded');
        return;
      }
      if (arg === 'scan') {
        ctx.ui.notify('Scanning...');
        await scan(true);
        ctx.ui.notify(
          `Done. ${Object.keys(gdpval).length} scores, ${cache.available_models?.length ?? 0} models.`
        );
        return;
      }
      if (arg === 'sync') {
        load();
        registerGroupModels(ctx);
        ctx.ui.notify('Re-registered group models');
        return;
      }

      if (arg && cfg.model_groups[arg]) {
        const g = cfg.model_groups[arg],
          res = resolve(arg);
        const desc =
          g.method === 'pipeline'
            ? `pipeline(${g.pipeline!.map((s) => `${s.method}:${s.top_k ?? '∞'}`).join('→')})`
            : g.method;
        const lines = [`${arg} | ${desc}`, g.description ?? '', ''];
        if (res) res.candidates.forEach((r, i) => lines.push(fmtModel(r, i, i === 0)));
        else lines.push('(no available models)');
        ctx.ui.notify(lines.filter(Boolean).join('\n'), 'info');
        return;
      }

      // Overview with table
      const lines: string[] = ['Model Router', ''];

      // Group tables with top 5 models (3 available + up to 2 limited)
      for (const [groupName, g] of Object.entries(cfg.model_groups)) {
        const top = getTopModels(groupName, 5);
        const method =
          g.method === 'pipeline'
            ? g.pipeline!.map((s) => `${s.method}${s.top_k ? `:${s.top_k}` : ''}`).join(' → ')
            : g.method === 'best'
              ? 'best gdpval'
              : g.method === 'tiered'
                ? g.min_gdpval != null
                  ? `tiered ≥${g.min_gdpval}`
                  : `tiered ≥${g.min_gdpval_pct ?? 0}%`
                : g.method === 'dynamic'
                  ? 'dynamic (content-based)'
                  : g.method;
        const active = curModel && allDiscoveredRefs().includes(curModel);
        const activeMarker = active ? ' ◀' : '';

        // Group header
        lines.push(`┌─ ${groupName}${activeMarker} `.padEnd(72, '─') + ` ${method} ─`);

        if (top.length === 0 && g.method === 'dynamic') {
          const cats = [
            'code_simple→operational',
            'code_complex→tactical',
            'design→strategic',
            'planning→tactical',
            'exploration→scout',
          ];
          lines.push('│ Routes per prompt via Ollama (gemma2:2b):');
          cats.forEach((c) => lines.push(`│   ${c}`));
        } else if (top.length === 0) {
          lines.push('│ (no models configured)');
        } else {
          // Compute max model name width (capped at 38)
          const MW = Math.min(38, Math.max(5, ...top.map((t) => t.ref.length)));

          // Table header
          lines.push(
            `│ ${'#'.padEnd(3)} ${'Model'.padEnd(MW)}  ${'GDP'.padStart(4)}  ${'Lat'.padStart(5)}  ${'TPS'.padStart(4)}  ${'Cost I/O'.padStart(11)}  ${'Usage 1d/7d/30d'.padStart(15)}  Status`
          );
          lines.push(
            `│ ${'─'.padEnd(3)} ${'─'.repeat(MW)}  ${'────'}  ${'─────'}  ${'────'}  ${'───────────'}  ${'───────────────'}  ──────`
          );

          for (const { ref, limited, rank } of top) {
            const m = getM(ref);
            const prov = ref.split('/')[0];
            const mux = costMux(prov);
            const cost = effCost(ref);
            const price = lookupPrice(ref);
            const modelShort = ref.length > MW ? '…' + ref.slice(-(MW - 1)) : ref;
            const isActive = curModel === ref;
            const statusParts: string[] = [];
            if (limited) statusParts.push(`⛔${limitSecs(ref)}s`);
            if (mux > 1) statusParts.push(`×${mux}`);
            if (isActive) statusParts.push('●');
            const status = statusParts.join(' ') || (limited ? '' : 'active');

            const costDisplay = price
              ? `$${price.input.toFixed(1)}/$${price.output.toFixed(1)}`
              : `$${cost.toFixed(1)}`;

            const u1 = getUsage(ref, 1),
              u7 = getUsage(ref, 7),
              u30 = getUsage(ref, 30);
            const usageDisplay = `${fmt(u1)}/${fmt(u7)}/${fmt(u30)}`;

            const sel = rank === 0 ? ' ←' : '';
            lines.push(
              `│ ${String(rank + 1).padEnd(3)} ${modelShort.padEnd(MW)}  ${String(m.gdpval).padStart(4)}  ${String(Math.round(m.avg_latency_ms)).padStart(5)}  ${String(Math.round(m.throughput_tps)).padStart(4)}  ${costDisplay.padStart(11)}  ${usageDisplay.padStart(15)}  ${status}${sel}`
            );
          }
        }
        lines.push('│');
      }

      // Rate-limited summary
      const rl = [...rateLimitManager.getLimits().keys()].filter((r) => isLimited(r));
      if (rl.length) {
        lines.push('├─ Rate Limited '.padEnd(72, '─'));
        for (const r of rl) {
          const { provider, modelId } = splitRef(r);
          lines.push(`│ ⛔ ${provider}/${modelId} (${limitSecs(r)}s remaining)`);
        }
      }

      lines.push('└' + '─'.repeat(71));
      lines.push('', '/router <group> | scan | reload | sync');
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  pi.on('session_shutdown', () => {
    sessionCtx = null;
    router.setSessionCtx(null);
  });

  // Export groupStream for testing
  (defaultExport as any).groupStream = groupStream;
};

export default defaultExport;
