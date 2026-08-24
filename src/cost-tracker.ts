// src/cost-tracker.ts
// Cost tracking for price-based routing

import type { CostMetrics } from './types.ts';
import { lookupPrice } from './metrics.ts';
import { routerLog } from './logger.ts';
import fs from 'node:fs';

/**
 * CostTracker - Tracks the costs of model requests for monitoring
 *
 * Features:
 * - Cost per request based on model and token count
 * - Statistics per model
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
      // Routine, not actionable — many models (subscription, local, newly
      // discovered) legitimately have no resolvable price yet. Spamming this
      // to stdout on every request corrupts the TUI's input prompt rendering
      // (raw console.* writes bypass ctx.ui.notify entirely). Opt-in only.
      if (process.env.DEBUG_COST_TRACKER === 'true') {
        routerLog('[cost-tracker] No price info for model', modelRef);
      }
      return;
    }

    // Check if price contains 'unknown' values
    if (price.input === 'unknown' || price.output === 'unknown') {
      if (process.env.DEBUG_COST_TRACKER === 'true') {
        routerLog('[cost-tracker] Price is unknown for model', modelRef);
      }
      return;
    }

    // Calculate cost: (inputTokens * inputPrice + outputTokens * outputPrice) / 1,000,000
    const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;

    // Update metrics
    this.metrics.totalCost += cost;
    this.metrics.totalInputTokens += inputTokens;
    this.metrics.totalOutputTokens += outputTokens;

    // Per model
    this.metrics.requestsByModel[modelRef] = (this.metrics.requestsByModel[modelRef] || 0) + 1;
    this.metrics.costByModel[modelRef] = (this.metrics.costByModel[modelRef] || 0) + cost;

    // Debug log (optional)
    if (process.env.DEBUG_COST_TRACKER === 'true') {
      routerLog(`[cost-tracker] ${modelRef}: $${cost.toFixed(6)} (in: ${inputTokens}, out: ${outputTokens})`);
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
   * Builds a human-readable summary of the current metrics WITHOUT any side
   * effects (no console output, no file write, no reset). Used both by
   * logSummary() (which adds those side effects) and by callers that want
   * an on-demand snapshot, e.g. the `/router cost` command — which must NOT
   * reset accumulated metrics just because someone looked at them.
   * @param customMessage - Optional custom message
   */
  formatSummary(customMessage: string = ''): string {
    const uptime = new Date().getTime() - this.startTime.getTime();
    const uptimeHours = (uptime / (1000 * 60 * 60)).toFixed(2);

    return [
      `=== Cost Tracker Summary ${customMessage ? `(${customMessage})` : ''} ===`,
      `Uptime: ${uptimeHours}h`,
      `Total Cost: $${this.metrics.totalCost.toFixed(6)}`,
      `Total Tokens: ${this.metrics.totalInputTokens + this.metrics.totalOutputTokens} (in: ${this.metrics.totalInputTokens}, out: ${this.metrics.totalOutputTokens})`,
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
  }

  /**
   * Logs a summary of the metrics (daily scheduled summary + process-exit
   * final summary). Only prints to console when DEBUG_COST_TRACKER=true —
   * an unconditional console.log here would surface mid-session (or right
   * as the process exits) and corrupt the TUI's input prompt, since raw
   * console writes bypass ctx.ui.notify entirely. File logging (when
   * logFilePath is configured) is unconditional since it doesn't touch the
   * terminal. Always resets metrics afterward (this is the periodic-reset
   * path; use formatSummary() for a non-resetting on-demand snapshot).
   * @param customMessage - Optional custom message
   */
  logSummary(customMessage: string = ''): void {
    const summary = this.formatSummary(customMessage);

    if (process.env.DEBUG_COST_TRACKER === 'true') {
      routerLog(`[cost-tracker] ${summary}`);
    }

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
