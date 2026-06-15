// src/cache.ts
// Cache-Handling für den pi-model-router

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Cache } from './types.js';

// ── Cache Management ───────────────────────────────────────────────────────

/**
 * Verwaltet den Cache für den pi-model-router
 */
export class CacheManager {
  private cache: Cache;
  private cachePath: string;

  constructor(extDir: string) {
    this.cachePath = path.join(extDir, '.cache', 'scan-cache.json');
    this.cache = this.loadCache();
  }

  /**
   * Lädt den Cache aus der Datei
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
   * Speichert den Cache in die Datei
   */
  saveCache(cache?: Cache): void {
    const dataToSave = cache ?? this.cache;
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    fs.writeFileSync(this.cachePath, JSON.stringify(dataToSave, null, 2));
  }

  /**
   * Gibt den aktuellen Cache zurück
   */
  getCache(): Cache {
    return this.cache;
  }

  /**
   * Aktualisiert den Cache
   */
  updateCache(updates: Partial<Cache>): void {
    this.cache = { ...this.cache, ...updates };
    this.saveCache();
  }

  /**
   * Setzt den Timestamp des letzten Scans
   */
  setLastScanTimestamp(timestamp: number = Date.now()): void {
    this.updateCache({ lastScanTimestamp: timestamp });
  }

  /**
   * Prüft, ob der Cache noch gültig ist (max. 30 Tage alt)
   */
  isScanCacheValid(): boolean {
    const lastScan = this.cache.lastScanTimestamp;
    if (lastScan === undefined) return false;
    
    const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000; // 30 Tage in Millisekunden
    const now = Date.now();
    const diff = now - lastScan;
    // Prüfe Lower Bound: diff >= 0 (keine Future Timestamps) und < 30 Tage
    return diff >= 0 && diff < thirtyDaysInMs;
  }

  /**
   * Setzt den Cache zurück
   */
  resetCache(): void {
    this.cache = {};
    this.saveCache();
  }

  /**
   * Aktualisiert die GDPval-Scores im Cache
   */
  updateGdpvalScores(scores: Record<string, number>): void {
    this.cache.gdpval_scores = scores;
    this.cache.gdpval_scraped = true;
    this.saveCache();
  }

  /**
   * Aktualisiert die verfügbaren Modelle im Cache
   */
  updateAvailableModels(models: { id: string; provider: string; cost_per_m: number }[]): void {
    this.cache.available_models = models;
    this.cache.models_cached = new Date().toISOString();
    this.saveCache();
  }

  /**
   * Aktualisiert die Benchmarks im Cache
   */
  updateBenchmarks(benchmarks: Record<string, number>): void {
    this.cache.benchmarks = benchmarks;
    this.saveCache();
  }

  /**
   * Aktualisiert die OpenRouter-Preisliste im Cache
   */
  updateOpenRouterPricing(pricing: Record<string, { input: number; output: number }>): void {
    this.cache.openrouter_pricing = pricing;
    this.saveCache();
  }

  /**
   * Fügt einen neuen Eintrag zum Usage-Log hinzu
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
   * Aktualisiert die erschöpften Keys im Cache
   */
  updateExhaustedKeys(exhaustedKeys: Record<string, number>): void {
    this.cache.exhausted_keys = exhaustedKeys;
    this.saveCache();
  }

  /**
   * Aktualisiert die Cost-Mux-Werte im Cache
   */
  updateCostMux(costMux: Record<string, number>, costMuxLastBump: Record<string, string>): void {
    this.cache.cost_mux = costMux;
    this.cache.cost_mux_last_bump = costMuxLastBump;
    this.saveCache();
  }
}
