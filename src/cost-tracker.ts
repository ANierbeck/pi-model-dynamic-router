// src/cost-tracker.ts
// Cost-Tracking für das preisbasierte Routing

import type { CostMetrics, CostTier } from './types.js';
import { lookupPrice } from './metrics.js';
import { getModelCostTier } from './cost-tiers.js';

/**
 * CostTracker - Verfolgt die Kosten von Modell-Anfragen für Monitoring
 * 
 * Features:
 * - Kosten pro Request basierend auf Modell und Token-Zahl
 * - Statistiken pro Kostenstufe (free/budget/premium)
 * - Statistiken pro Modell
 * - Tägliche Zusammenfassung
 */
export class CostTracker {
  private metrics: CostMetrics;
  private startTime: Date;
  private logInterval: NodeJS.Timeout | null = null;
  private logFilePath: string;

  /**
   * Erstellt einen neuen CostTracker
   * @param logFilePath - Pfad zur Log-Datei für die tägliche Zusammenfassung
   */
  constructor(logFilePath: string = '') {
    this.metrics = this.createEmptyMetrics();
    this.startTime = new Date();
    this.logFilePath = logFilePath;
    
    // Tägliche Zusammenfassung um Mitternacht
    this.scheduleDailySummary();
  }

  /**
   * Erstellt leere Metriken
   */
  private createEmptyMetrics(): CostMetrics {
    return {
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      requestsByTier: { free: 0, budget: 0, premium: 0 },
      costByTier: { free: 0, budget: 0, premium: 0 },
      requestsByModel: {},
      costByModel: {},
    };
  }

  /**
   * Plant die tägliche Zusammenfassung um Mitternacht
   */
  private scheduleDailySummary(): void {
    // Berechne Zeit bis Mitternacht
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - now.getTime();

    // Setze Timeout für Mitternacht (unref um Process-Exit zu ermöglichen)
    this.logInterval = setTimeout(() => {
      this.logSummary();
      // Plane nächste Zusammenfassung
      this.scheduleDailySummary();
    }, msUntilMidnight);
    this.logInterval.unref();
  }

  /**
   * Verfolgt eine Modell-Anfrage
   * @param modelRef - Modell-Referenz (z.B. 'openrouter/qwen/qwen3-4b:free')
   * @param inputTokens - Anzahl der Input-Tokens
   * @param outputTokens - Anzahl der Output-Tokens
   */
  trackRequest(modelRef: string, inputTokens: number, outputTokens: number): void {
    const price = lookupPrice(modelRef);
    if (!price) {
      console.warn(`[cost-tracker] No price info for model: ${modelRef}`);
      return;
    }

    // Berechne Kosten: (inputTokens * inputPrice + outputTokens * outputPrice) / 1.000.000
    const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
    const tier = getModelCostTier(modelRef);

    // Aktualisiere Metriken
    this.metrics.totalCost += cost;
    this.metrics.totalInputTokens += inputTokens;
    this.metrics.totalOutputTokens += outputTokens;
    
    // Pro Kostenstufe
    this.metrics.requestsByTier[tier] = (this.metrics.requestsByTier[tier] || 0) + 1;
    this.metrics.costByTier[tier] = (this.metrics.costByTier[tier] || 0) + cost;
    
    // Pro Modell
    this.metrics.requestsByModel[modelRef] = (this.metrics.requestsByModel[modelRef] || 0) + 1;
    this.metrics.costByModel[modelRef] = (this.metrics.costByModel[modelRef] || 0) + cost;

    // Debug-Log (optional)
    if (process.env.DEBUG_COST_TRACKER === 'true') {
      console.log(`[cost-tracker] ${modelRef} [${tier}]: $${cost.toFixed(6)} (in: ${inputTokens}, out: ${outputTokens})`);
    }
  }

  /**
   * Gibt die aktuellen Metriken zurück
   */
  getMetrics(): CostMetrics {
    return { ...this.metrics };
  }

  /**
   * Setzt die Metriken zurück (z.B. für Tests)
   */
  resetMetrics(): void {
    this.metrics = this.createEmptyMetrics();
    this.startTime = new Date();
  }

  /**
   * Loggt eine Zusammenfassung der Metriken
   * @param customMessage - Optionale benutzerdefinierte Nachricht
   */
  logSummary(customMessage: string = ''): void {
    const uptime = new Date().getTime() - this.startTime.getTime();
    const uptimeHours = (uptime / (1000 * 60 * 60)).toFixed(2);

    const summary = [
      `=== Cost Tracker Summary ${customMessage ? `(${customMessage})` : ''} ===`,
      `Uptime: ${uptimeHours}h`,
      `Total Cost: $${this.metrics.totalCost.toFixed(6)}`,
      `Total Tokens: ${this.metrics.totalInputTokens + this.metrics.totalOutputTokens} (in: ${this.metrics.totalInputTokens}, out: ${this.metrics.totalOutputTokens})`,
      ``,
      `--- By Tier ---`,
      ...Object.entries(this.metrics.requestsByTier).map(([tier, count]) => 
        `  ${tier}: ${count} requests, $${this.metrics.costByTier[tier as CostTier].toFixed(6)}`
      ),
      ``,
      `--- By Model (Top 5) ---`,
      ...Object.entries(this.metrics.costByModel)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([model, cost]) => 
          `  ${model}: $${cost.toFixed(6)} (${this.metrics.requestsByModel[model]} requests)`
        ),
      `==========================`,
    ].join('\n');

    console.log(`[cost-tracker] ${summary}`);

    // In Datei schreiben, falls Pfad angegeben
    if (this.logFilePath) {
      import('node:fs').then(({ appendFileSync }) => {
        appendFileSync(this.logFilePath, `\n${new Date().toISOString()} - Cost Tracker Summary\n${summary}\n`);
      }).catch(() => {
        // Ignoriere Fehler beim Schreiben
      });
    }

    // Metriken zurücksetzen
    this.resetMetrics();
  }

  /**
   * Beendet den CostTracker und räumt auf
   */
  destroy(): void {
    if (this.logInterval) {
      clearTimeout(this.logInterval);
      this.logInterval = null;
    }
    // Finale Zusammenfassung
    this.logSummary('Final');
  }

  /**
   * Gibt eine Zusammenfassung als JSON zurück (für APIs)
   */
  getSummaryJson(): string {
    const uptime = new Date().getTime() - this.startTime.getTime();
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      uptimeMs: uptime,
      metrics: this.metrics,
    }, null, 2);
  }
}

// Singleton-Instanz für einfache Nutzung
export const costTracker = new CostTracker();
