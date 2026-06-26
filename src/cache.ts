// src/cache.ts
// Cache handling for the pi-model-router

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Cache } from './types.js';

// ── Cache Management ───────────────────────────────────────────────────────

/**
 * Manages the cache for the pi-model-router
 */
export class CacheManager {
  private cache: Cache;
  private cachePath: string;

  constructor(extDir: string) {
    this.cachePath = path.join(extDir, '.cache', 'scan-cache.json');
    this.cache = this.loadCache();
  }

  /**
   * Loads the cache from the file
   */
  loadCache(): Cache {
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
   * Saves the cache to the file
   */
  saveCache(cache?: Cache): void {
    const dataToSave = cache ?? this.cache;
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    fs.writeFileSync(this.cachePath, JSON.stringify(dataToSave, null, 2));
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
    this.cache = { ...this.cache, ...updates };
    this.saveCache();
  }

  /**
   * Sets the timestamp of the last scan
   */
  setLastScanTimestamp(timestamp: number = Date.now()): void {
    this.updateCache({ lastScanTimestamp: timestamp });
  }

  /**
   * Checks whether the cache is still valid (max. 30 days old)
   */
  isScanCacheValid(): boolean {
    const lastScan = this.cache.lastScanTimestamp;
    if (lastScan === undefined) return false;
    
    const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
    const now = Date.now();
    const diff = now - lastScan;
    // Check lower bound: diff >= 0 (no future timestamps) and < 30 days
    return diff >= 0 && diff < thirtyDaysInMs;
  }

  /**
   * Resets the cache
   */
  resetCache(): void {
    this.cache = {};
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
