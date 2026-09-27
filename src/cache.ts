// src/cache.ts
// Cache handling for the pi-model-router

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Cache } from './types.ts';

// ── Cache Management ───────────────────────────────────────────────────────

// Per cache object: the file state (mtime + size) it was last synced with,
// by a read or a write. Keyed by the object, not the manager, because index.ts
// rebuilds the manager on every load() but keeps the one cache object.
const lastSync = new WeakMap<Cache, string>();

/**
 * Adds what another process wrote without discarding in-memory state: keys
 * the memory lacks are taken from disk, and for record-valued keys
 * (model_blocklist, exhausted_keys, …) the missing entries. On a conflict
 * the memory wins — it may hold changes not saved yet.
 */
function mergeExternal(memory: Cache, disk: Cache): void {
  const mem = memory as Record<string, unknown>;
  for (const [key, diskValue] of Object.entries(disk as Record<string, unknown>)) {
    const memValue = mem[key];
    if (memValue === undefined) {
      mem[key] = diskValue;
    } else if (isRecord(memValue) && isRecord(diskValue)) {
      for (const [sub, v] of Object.entries(diskValue)) if (!(sub in memValue)) memValue[sub] = v;
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Manages the cache for the pi-model-router
 */
export class CacheManager {
  private cache: Cache;
  private cachePath: string;

  /**
   * `existing` is the caller's in-memory cache: a manager rebuilt on reload
   * must keep writing that one object instead of a fresh copy from disk.
   */
  constructor(stateDir: string, existing?: Cache) {
    this.cachePath = path.join(stateDir, '.cache', 'scan-cache.json');
    if (existing) {
      this.cache = existing;
    } else {
      this.cache = {};
      this.loadCache();
    }
  }

  /** mtime + size of the cache file, or '' when there is none. */
  private fileState(): string {
    try {
      const st = fs.statSync(this.cachePath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '';
    }
  }

  private readFromDisk(): Cache {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      if (fs.existsSync(this.cachePath)) {
        return JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
      }
    } catch {
      /* first run */
    }
    return {};
  }

  /**
   * Syncs the manager's object with disk and returns it; the object's identity
   * never changes, so every holder (index.ts, DiscoveryManager,
   * RateLimitManager, router, metrics) keeps seeing the same state.
   *
   * - First load of an object: fills it from disk.
   * - Later loads (every session_start, in-process subagents included): the
   *   memory is authoritative — the router saves only every 10 turns, so
   *   rate-limit cooldowns, model health, watchdog state and Tier-2 streaks
   *   may not be on disk yet. Disk is read only if another process wrote the
   *   file since the last sync, and its additions are merged in
   *   (mergeExternal). Review 2026-09-27: replacing the object's contents
   *   dropped that state; replacing the object let a stale holder undo the
   *   re-read and overwrite the other process's writes.
   */
  loadCache(): Cache {
    const known = lastSync.get(this.cache);
    const state = this.fileState();
    if (known !== undefined && known === state) return this.cache;
    const disk = this.readFromDisk();
    if (known === undefined && Object.keys(this.cache).length === 0) Object.assign(this.cache, disk);
    else mergeExternal(this.cache, disk);
    lastSync.set(this.cache, state);
    return this.cache;
  }

  /**
   * Saves the cache to the file
   */
  saveCache(cache?: Cache): void {
    const dataToSave = cache ?? this.cache;
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    fs.writeFileSync(this.cachePath, JSON.stringify(dataToSave, null, 2));
    lastSync.set(dataToSave, this.fileState());
  }

  /**
   * Returns the current cache
   */
  getCache(): Cache {
    return this.cache;
  }

  /**
   * Updates the cache
   */
  updateCache(updates: Partial<Cache>): void {
    Object.assign(this.cache, updates);
    this.saveCache();
  }

  /**
   * Sets the timestamp of the last scan
   */
  setLastScanTimestamp(timestamp: number = Date.now()): void {
    this.updateCache({ lastScanTimestamp: timestamp });
  }

  /**
   * Checks whether the cache is still valid (max. 30 days old).
   *
   * Also rejects a cache that is timestamp-fresh but EMPTY (0 available
   * models) — this was F8 in the 2026-09-02 architecture review: the
   * repo-root `.cache/scan-cache.json` had a fresh `lastScanTimestamp` but
   * `available_models: 0`, `gdpval_scores: 0`, `openrouter_pricing: 0`.
   * Both the empty cache and the populated dist cache passed the 30-day
   * freshness check, so neither triggered a rescan — tests/dev ran against
   * zero models. An empty-but-fresh cache is almost certainly a write
   * failure or a partial cache; force a rescan so the next scan repopulates
   * it rather than silently serving nothing.
   */
  isScanCacheValid(cache: Cache = this.cache): boolean {
    const lastScan = cache.lastScanTimestamp;
    if (lastScan === undefined) return false;

    const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
    const now = Date.now();
    const diff = now - lastScan;
    // Check lower bound: diff >= 0 (no future timestamps) and < 30 days
    if (!(diff >= 0 && diff < thirtyDaysInMs)) return false;

    // Sanity check (F8): a fresh timestamp with zero models means the cache
    // is useless — force a rescan so we don't serve an empty cache forever.
    const modelCount = cache.available_models?.length ?? 0;
    if (modelCount === 0) return false;

    return true;
  }

  /**
   * Resets the cache
   */
  resetCache(): void {
    for (const key of Object.keys(this.cache)) delete (this.cache as Record<string, unknown>)[key];
    this.saveCache();
  }

  /**
   * Updates the GDPval scores in the cache
   */
  updateGdpvalScores(scores: Record<string, number>): void {
    this.cache.gdpval_scores = scores;
    this.cache.gdpval_scraped = true;
    this.saveCache();
  }

  /**
   * Updates the available models in the cache
   */
  updateAvailableModels(models: { id: string; provider: string; cost_per_m: number }[]): void {
    this.cache.available_models = models;
    this.cache.models_cached = new Date().toISOString();
    this.saveCache();
  }

  /**
   * Updates the benchmarks in the cache
   */
  updateBenchmarks(benchmarks: Record<string, number>): void {
    this.cache.benchmarks = benchmarks;
    this.saveCache();
  }

  /**
   * Updates the OpenRouter pricing list in the cache
   */
  updateOpenRouterPricing(pricing: Record<string, { input: number; output: number }>): void {
    this.cache.openrouter_pricing = pricing;
    this.saveCache();
  }

  /**
   * Adds a new entry to the usage log
   */
  addUsageLogEntry(ref: string, tokens: number): void {
    if (!this.cache.usage_log) this.cache.usage_log = [];
    this.cache.usage_log.push({ ref, tokens, ts: Date.now() });
    // Trim log to last 30 days
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    this.cache.usage_log = this.cache.usage_log.filter((e) => e.ts > cutoff);
    this.saveCache();
  }

  /**
   * Updates the exhausted keys in the cache
   */
  updateExhaustedKeys(exhaustedKeys: Record<string, number>): void {
    this.cache.exhausted_keys = exhaustedKeys;
    this.saveCache();
  }

  /**
   * Updates the cost mux values in the cache
   */
  updateCostMux(costMux: Record<string, number>, costMuxLastBump: Record<string, string>): void {
    this.cache.cost_mux = costMux;
    this.cache.cost_mux_last_bump = costMuxLastBump;
    this.saveCache();
  }
}
