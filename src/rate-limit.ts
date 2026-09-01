// src/rate-limit.ts
// Rate limit handling for the pi-model-router

import type { RateLimit, Cache } from './types.ts';
import { splitRef } from './utils.ts';

// ── Constants ────────────────────────────────────────────────────────────

const KEY_COOLDOWN = 3_600_000; // 1hr per exhausted key

// ── Shared cooldown check (single source of truth) ─────────────────────────
//
// Both RateLimitManager (the owner of the state) and routing.ts's Router
// (constructed with a reference to the SAME Map, not a copy) need to answer
// "is this ref still in cooldown". Previously each had its own byte-identical
// isLimited/limitSecs implementation over the shared Map — a fix to one
// wouldn't apply to the other. Both now delegate to these pure functions.

/**
 * Returns true if `ref` is currently rate-limited per `limits`. Expired
 * entries are deleted as a side effect (lazy cleanup on read).
 */
export function isRefLimited(limits: Map<string, RateLimit>, ref: string): boolean {
  const limit = limits.get(ref);
  if (!limit) return false;
  if (Date.now() >= limit.cooldown_until) {
    limits.delete(ref);
    return false;
  }
  return true;
}

/** Returns the remaining cooldown seconds for `ref`, or 0 if not limited. */
export function refLimitSecs(limits: Map<string, RateLimit>, ref: string): number {
  const limit = limits.get(ref);
  return limit ? Math.max(0, Math.ceil((limit.cooldown_until - Date.now()) / 1000)) : 0;
}

// ── Rate Limit Management ────────────────────────────────────────────────

/**
 * Manages rate limits for models and providers
 */
export class RateLimitManager {
  private limits: Map<string, RateLimit> = new Map();
  private backoffMinutes: number[];
  private softBackoffMs: number[];
  private costMuxAtHit: number;
  private cache: Cache;
  private activeKeyIdx: Record<string, number> = {};

  constructor(
    backoffMinutes: number[],
    softBackoffMs: number[],
    costMuxAtHit: number,
    cache: Cache
  ) {
    this.backoffMinutes = backoffMinutes;
    this.softBackoffMs = softBackoffMs;
    this.costMuxAtHit = costMuxAtHit;
    this.cache = cache;
  }

  // ── Public Accessors ────────────────────────────────────────────────────

  /**
   * Returns the rate limit map (for router integration)
   */
  getLimits(): Map<string, RateLimit> {
    return this.limits;
  }

  // ── Key Management ─────────────────────────────────────────────────────

  /**
   * Returns true if the key at the given index is in its cooldown period
   */
  isKeyExhausted(prov: string, idx: number): boolean {
    const until = this.cache.exhausted_keys?.[`${prov}:${idx}`];
    if (!until) return false;
    if (Date.now() >= until) {
      if (this.cache.exhausted_keys) delete this.cache.exhausted_keys[`${prov}:${idx}`];
      return false;
    }
    return true;
  }

  /**
   * Marks a key as exhausted for KEY_COOLDOWN ms
   */
  exhaustKey(prov: string, idx: number): void {
    if (!this.cache.exhausted_keys) this.cache.exhausted_keys = {};
    this.cache.exhausted_keys[`${prov}:${idx}`] = Date.now() + KEY_COOLDOWN;
  }

  /**
   * Attempts to rotate to the next available key for a provider.
   * Returns true if rotation succeeded.
   */
  rotateKey(prov: string, keys: { key: string; label?: string }[]): boolean {
    if (!keys || keys.length <= 1) return false;

    const curIdx = this.activeKeyIdx[prov] ?? 0;
    this.exhaustKey(prov, curIdx);

    for (let i = 1; i < keys.length; i++) {
      const nextIdx = (curIdx + i) % keys.length;
      if (!this.isKeyExhausted(prov, nextIdx)) {
        this.activeKeyIdx[prov] = nextIdx;
        return true;
      }
    }
    return false; // all keys exhausted
  }

  /**
   * Returns the label of the currently active key for a provider
   */
  activeKeyLabel(prov: string, keys: { key: string; label?: string }[]): string | null {
    if (!keys || keys.length <= 1) return null;
    const idx = this.activeKeyIdx[prov] ?? 0;
    return keys[idx]?.label ?? `key-${idx}`;
  }

  // ── Rate Limit Tracking ────────────────────────────────────────────────

  /**
   * Returns true if the given model reference is currently rate-limited
   */
  isLimited(ref: string): boolean {
    return isRefLimited(this.limits, ref);
  }

  /**
   * Records a rate-limit error and attempts key rotation.
   * Returns whether rotation succeeded and the new key label if so.
   *
   * `resetAtMs` (optional) — when present, the cooldown is forced to be at
   * least as long as the gap from now until the provider's window actually
   * resets. This prevents a real provider reset time (e.g. 2.5h from now) from
   * being capped at the backoff schedule's 90-minute ceiling — which used to
   * cause the same model to get re-picked and re-rate-limited in a tight
   * loop near the end of the user's 5-hour window. The schedule still
   * escalates the backoff for repeated hits; resetAtMs only ensures we wait
   * at least until the window resets.
   */
  recordLimit(
    ref: string,
    providerKeys: Record<string, { keys?: { key: string; label?: string }[] }>,
    resetAtMs?: number
  ): { rotated: boolean; newKey?: string } {
    const { provider } = splitRef(ref);

    // Versuche zuerst Key-Rotation
    const keys = providerKeys[provider]?.keys;
    if (keys && this.rotateKey(provider, keys)) {
      const label = this.activeKeyLabel(provider, keys) ?? 'next';
      return { rotated: true, newKey: label };
    }

    // Keine Keys zum Rotieren — fall back zu Model-Level Backoff
    const prev = this.limits.get(ref);
    const hits = (prev?.hits ?? 0) + 1;
    const backoffIndex = Math.min(hits - 1, this.backoffMinutes.length - 1);
    // this.backoffMinutes is ALREADY in milliseconds (converted from minutes
    // in index.ts via .map(m => m * 60_000)). Do NOT multiply by 60_000 again!
    // Bug history: the double multiplication produced 60.000 * 60.000 = 3.6B ms
    // = 41.67 days cooldown — blocking ALL models for over a month.
    const ms = this.backoffMinutes[backoffIndex];

    // If a reset time is known, use the LONGER of (escalating backoff,
    // wait-until-reset). Without this, a hit near the end of a 5-hour window
    // gets capped at 90m, the model is re-picked, fails again, escalates —
    // a tight loop until the window actually resets. With it, the cooldown
    // is exactly right the first time.
    let cooldown_ms = ms;
    if (resetAtMs && Number.isFinite(resetAtMs)) {
      const untilReset = Math.max(0, resetAtMs - Date.now());
      if (untilReset > cooldown_ms) cooldown_ms = untilReset;
    }

    this.limits.set(ref, {
      cooldown_until: Date.now() + cooldown_ms,
      backoff_ms: ms,
      hits,
      ...(resetAtMs && Number.isFinite(resetAtMs) ? { resetAtMs } : {}),
    });

    // After enough consecutive hits, apply a costMux penalty to the provider
    if (hits === this.costMuxAtHit) {
      this.bumpMux(provider, splitRef(ref).modelId);
    }

    return { rotated: false };
  }

  /**
   * Records a successful call (resets hit counter)
   */
  recordOk(ref: string): void {
    const limit = this.limits.get(ref);
    if (limit) limit.hits = 0;
  }

  /**
   * Fully clears any cooldown/backoff state for a ref — used when the user
   * explicitly overrides the router (e.g. via HINT), so a stale cooldown from
   * an earlier, unrelated failure doesn't silently block a deliberate choice.
   */
  clearLimit(ref: string): void {
    this.limits.delete(ref);
  }

  /**
   * Records a soft failure (empty response, timeout)
   */
  recordSoftFailure(ref: string): void {
    const prev = this.limits.get(ref);
    const hits = (prev?.hits ?? 0) + 1;
    const backoffIndex = Math.min(hits - 1, this.softBackoffMs.length - 1);
    const ms = this.softBackoffMs[backoffIndex];
    this.limits.set(ref, { cooldown_until: Date.now() + ms, backoff_ms: ms, hits });
  }

  /**
   * Returns the remaining cooldown seconds for a rate-limited reference
   */
  limitSecs(ref: string): number {
    return refLimitSecs(this.limits, ref);
  }

  // ── Cost Mux Management ────────────────────────────────────────────────

  /**
   * Returns the current cost multiplier for a provider
   */
  costMux(prov: string): number {
    return this.cache.cost_mux?.[prov] ?? 1;
  }

  /**
   * Increments the cost multiplier for a provider
   */
  bumpMux(prov: string, modelId: string): void {
    // at most one bump per calendar day
    const last = this.cache.cost_mux_last_bump?.[prov];
    if (
      last &&
      new Date(last).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)
    ) {
      return;
    }

    // Only bump if the model is still listed as available
    if (
      this.cache.available_models &&
      !this.cache.available_models.some((m) => m.provider === prov && m.id === modelId)
    ) {
      return;
    }

    if (!this.cache.cost_mux) this.cache.cost_mux = {};
    if (!this.cache.cost_mux_last_bump) this.cache.cost_mux_last_bump = {};
    this.cache.cost_mux[prov] = (this.cache.cost_mux[prov] ?? 1) + 1;
    this.cache.cost_mux_last_bump[prov] = new Date().toISOString();
  }

  // ── Cache Sync ────────────────────────────────────────────────────────

  /** Replace the managed cache reference. */
  updateCache(newCache: Cache): void {
    this.cache = newCache;
  }

  // ── Getter ─────────────────────────────────────────────────────────────

  getActiveKeyIdx(): Record<string, number> {
    return this.activeKeyIdx;
  }
}
