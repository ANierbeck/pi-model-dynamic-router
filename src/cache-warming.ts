// src/cache-warming.ts
// Honor Pi's `cacheWarming` setting in router sessions
// (docs/plans/2026-11-20-honor-pi-cache-warming.md).
//
// Pi (1.6.0+) owns WHEN a prompt cache is warmed: the user's mode
// (`off` / `streaming` / `idle`), the 30-minute idle limit, the
// expected-savings threshold and the `cache_warming_decision` hook all live
// in Pi's CacheWarmer. The router does not re-implement any of it; it only
// supplies what Pi cannot know about a virtual group model:
//   1. the served model's prompt-cache lifetime and price, declared on the
//      group model so Pi's gates can evaluate it (cacheEconomicsFor);
//   2. the model a warm must reach — the one that served the session's last
//      request — so the replay hits the cache it is meant to keep alive
//      (isPiCacheWarmRequest marks the requests that bypass routing);
//   3. the warm usage Pi records (`cache_warm` usage entries), read for the
//      5b/5c cold-cache signal, the footer and `/router cost`.

import type {
  Api,
  Model,
  ModelCost,
  ModelPromptCache,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';

/** Pi's `UsageEntry.kind` for a successful cache warm (cache-warmer.js). */
export const CACHE_WARM_USAGE_KIND = 'cache_warm';

/**
 * Whether `options` are Pi's cache-warm replay options
 * (pi-ai `getCacheWarmingRequestOptions`: the request's own options with
 * `maxTokens: 1`, `disableContinuation: true`, `maxRetries: 0`).
 * `disableContinuation` is documented for replays such as cache warming; the
 * full triple keeps an ordinary one-token request out of this path.
 */
export function isPiCacheWarmRequest(options: SimpleStreamOptions | undefined): boolean {
  return (
    options?.maxTokens === 1 && options.disableContinuation === true && options.maxRetries === 0
  );
}

/** What a group model declares so Pi's CacheWarmer can judge a warm. */
export interface DeclaredCacheEconomics {
  /** The served model's prompt-cache lifetimes; absent = Pi does not warm. */
  promptCache?: ModelPromptCache;
  cost: ModelCost;
}

/** A group model's economics before anything was served: no lifetime, zero price. */
export const UNDECLARED_CACHE_ECONOMICS: DeclaredCacheEconomics = {
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * The economics a group model declares after `served` answered a request
 * sent with `options`.
 *
 * Mirrors Pi's replay gate (pi-ai `isCacheWarmingReplayable`): Anthropic's
 * budget-based thinking derives its budget from `max_tokens`, so a one-token
 * replay would change the cache key. Pi checks this against the SESSION
 * model — the group model, whose api is the router's own placeholder — so
 * the gate would always pass; the router withholds the lifetime instead.
 */
export function cacheEconomicsFor(
  served: Model<Api>,
  options: SimpleStreamOptions | undefined
): DeclaredCacheEconomics {
  const compat = served.compat as { forceAdaptiveThinking?: boolean } | undefined;
  const replayable =
    !options?.reasoning ||
    served.api !== 'anthropic-messages' ||
    compat?.forceAdaptiveThinking === true;
  return replayable && served.promptCache
    ? { promptCache: served.promptCache, cost: served.cost }
    : { cost: served.cost };
}

/** Structural equality of two declarations (re-register only on a change). */
export function sameCacheEconomics(a: DeclaredCacheEconomics, b: DeclaredCacheEconomics): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Shape of Pi's `UsageEntry` the router reads (session-manager.d.ts). */
interface UsageEntryLike {
  type: 'usage';
  kind: string;
  timestamp: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
}

/** Whether a session entry is one of Pi's `cache_warm` usage entries. */
export function isCacheWarmEntry(entry: unknown): entry is UsageEntryLike {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Partial<UsageEntryLike>;
  return (
    e.type === 'usage' &&
    e.kind === CACHE_WARM_USAGE_KIND &&
    typeof e.usage === 'object' &&
    e.usage !== null
  );
}

/** Sum of Pi's recorded cache warms (only successful warms are recorded). */
export interface CacheWarmTotals {
  count: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export function cacheWarmTotals(entries: readonly unknown[] | undefined): CacheWarmTotals {
  const totals: CacheWarmTotals = {
    count: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  for (const entry of entries ?? []) {
    if (!isCacheWarmEntry(entry)) continue;
    const u = entry.usage;
    totals.count++;
    totals.input += u.input ?? 0;
    totals.output += u.output ?? 0;
    totals.cacheRead += u.cacheRead ?? 0;
    totals.cacheWrite += u.cacheWrite ?? 0;
    totals.cost += u.cost?.total ?? 0;
  }
  return totals;
}

/**
 * The most recent recorded warm: its time (ms) and its cache share
 * (cacheRead over everything the replay read). null = no warm recorded.
 */
export function latestCacheWarm(
  entries: readonly unknown[] | undefined
): { ts: number; cacheShare: number | null } | null {
  const list = entries ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (!isCacheWarmEntry(entry)) continue;
    const ts = Date.parse(entry.timestamp);
    if (!Number.isFinite(ts)) continue;
    const u = entry.usage;
    const read = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    return { ts, cacheShare: read > 0 ? (u.cacheRead ?? 0) / read : null };
  }
  return null;
}
