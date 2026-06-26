// src/cost-tracker.ts
// Cost tracking for price-based routing

import type { CostMetrics, CostTier } from './types.js';
import { lookupPrice } from './metrics.js';
import { getModelCostTier } from './cost-tiers.js';
import fs from 'node:fs';

/**
 * CostTracker - Tracks the costs of model requests for monitoring
 *
 * Features:
 * - Cost per request based on model and token count
 * - Statistics per cost tier (free/budget/premium)
 * - Statistics per model
 * - Daily summary
 */
export class CostTracker {
  private metrics: CostMetrics;
  private startTime: Date;
  private logInterval: NodeJS.Timeout | null = null;
  private logFilePath: string;

  /**
   * Creates a new CostTracker
   * @param logFilePath - Path to the log file for the daily summary
   */
  constructor(logFilePath: string = '') {
    this.metrics = this.createEmptyMetrics();
    this.startTime = new Date();
    this.logFilePath = logFilePath;
    
    // Daily summary at midnight
    this.scheduleDailySummary();
  }

  /**
   * Creates empty metrics
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
   * Schedules the daily summary at midnight
   */
  private scheduleDailySummary(): void {
    // Calculate time until midnight
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - now.getTime();

    // Set timeout for midnight (unref to allow process exit)
    this.logInterval = setTimeout(() => {
      this.logSummary();
      // Schedule next summary
      this.scheduleDailySummary();
    }, msUntilMidnight);
    this.logInterval.unref();
  }

  /**
   * Tracks a model request
   * @param modelRef - Model reference (e.g. 'openrouter/qwen/qwen3-4b:free')
   * @param inputTokens - Number of input tokens
   * @param outputTokens - Number of output tokens
   */
  trackRequest(modelRef: string, inputTokens: number, outputTokens: number): void {
    const price = lookupPrice(modelRef);
    if (!price) {
      console.warn(`[cost-tracker] No price info for model: ${modelRef}`);
      return;
    }

    // Calculate cost: (inputTokens * inputPrice + outputTokens * outputPrice) / 1,000,000
    const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
    const tier = getModelCostTier(modelRef);

    // Update metrics
    this.metrics.totalCost += cost;
    this.metrics.totalInputTokens += inputTokens;
    this.metrics.totalOutputTokens += outputTokens;
    
    // Per cost tier
    this.metrics.requestsByTier[tier] = (this.metrics.requestsByTier[tier] || 0) + 1;
    this.metrics.costByTier[tier] = (this.metrics.costByTier[tier] || 0) + cost;
    
    // Per model
    this.metrics.requestsByModel[modelRef] = (this.metrics.requestsByModel[modelRef] || 0) + 1;
    this.metrics.costByModel[modelRef] = (this.metrics.costByModel[modelRef] || 0) + cost;

    // Debug log (optional)
    if (process.env.DEBUG_COST_TRACKER === 'true') {
      console.log(`[cost-tracker] ${modelRef} [${tier}]: $${cost.toFixed(6)} (in: ${inputTokens}, out: ${outputTokens})`);
    }
  }

  /**
   * Returns the current metrics
   */
  getMetrics(): CostMetrics {
    return { ...this.metrics };
  }

  /**
   * Resets the metrics (e.g. for tests)
   */
  resetMetrics(): void {
    this.metrics = this.createEmptyMetrics();
    this.startTime = new Date();
  }

  /**
   * Logs a summary of the metrics
   * @param customMessage - Optional custom message
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

    // Write to file if path is specified
    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, `\n${new Date().toISOString()} - Cost Tracker Summary\n${summary}\n`);
      } catch {
        // Ignore errors during writing
      }
    }

    // Reset metrics
    this.resetMetrics();
  }

  /**
   * Stops the CostTracker and cleans up
   */
  destroy(): void {
    if (this.logInterval) {
      clearTimeout(this.logInterval);
      this.logInterval = null;
    }
    // Final summary
    this.logSummary('Final');
  }

  /**
   * Returns a summary as JSON (for APIs)
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

// Singleton instance for easy use
export const costTracker = new CostTracker();
