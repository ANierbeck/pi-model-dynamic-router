// src/rate-limit.ts
// Rate limit handling for the pi-model-router

import type { RateLimit, Cache } from './types.js';
import { splitRef } from './utils.js';

// ── Constants ────────────────────────────────────────────────────────────

const KEY_COOLDOWN = 3_600_000; // 1hr per exhausted key

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
    const limit = this.limits.get(ref);
    if (!limit) return false;
    if (Date.now() >= limit.cooldown_until) {
      this.limits.delete(ref);
      return false;
    }
    return true;
  }

  /**
   * Records a rate-limit error and attempts key rotation.
   * Returns whether rotation succeeded and the new key label if so.
   */
  recordLimit(
    ref: string,
    providerKeys: Record<string, { keys?: { key: string; label?: string }[] }>
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
    const ms = this.backoffMinutes[backoffIndex] * 60_000;

    this.limits.set(ref, { cooldown_until: Date.now() + ms, backoff_ms: ms, hits });

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
    const limit = this.limits.get(ref);
    return limit ? Math.max(0, Math.ceil((limit.cooldown_until - Date.now()) / 1000)) : 0;
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
