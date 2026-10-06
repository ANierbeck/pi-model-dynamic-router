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
      tokensByModel: {},
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
   * @param cacheReadTokens - Provider-reported cache reads (Phase 5a; not part of the marginal cost estimate)
   * @param cacheWriteTokens - Provider-reported cache writes (Phase 5a)
   */
  trackRequest(
    modelRef: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0
  ): void {
    const price = lookupPrice(modelRef);
    // Models without a resolvable price (subscription via registry gap,
    // local, newly discovered) still COUNT — requests and in/out tokens are
    // recorded with marginal cost $0, so the audit-depth /router cost report
    // shows ALL models that actually served the session instead of silently
    // dropping them (owner decision 2026-09-27). Diagnostics stay opt-in:
    // unconditional stdout corrupts the TUI's input prompt rendering.
    if (!price || price.input === 'unknown' || price.output === 'unknown') {
      if (process.env.DEBUG_COST_TRACKER === 'true') {
        routerLog('[cost-tracker] No price info for model', modelRef);
      }
    }

    // Calculate cost: (inputTokens * inputPrice + outputTokens * outputPrice) / 1,000,000
    const cost =
      price && price.input !== 'unknown' && price.output !== 'unknown'
        ? (inputTokens * (price.input as number) + outputTokens * (price.output as number)) / 1_000_000
        : 0;

    // Update metrics
    this.metrics.totalCost += cost;
    this.metrics.totalInputTokens += inputTokens;
    this.metrics.totalOutputTokens += outputTokens;
    this.metrics.totalCacheReadTokens = (this.metrics.totalCacheReadTokens ?? 0) + cacheReadTokens;
    this.metrics.totalCacheWriteTokens = (this.metrics.totalCacheWriteTokens ?? 0) + cacheWriteTokens;

    // Per model
    this.metrics.requestsByModel[modelRef] = (this.metrics.requestsByModel[modelRef] || 0) + 1;
    this.metrics.costByModel[modelRef] = (this.metrics.costByModel[modelRef] || 0) + cost;
    if (!this.metrics.tokensByModel) this.metrics.tokensByModel = {};
    const tok = this.metrics.tokensByModel[modelRef] ?? { in: 0, out: 0 };
    tok.in += inputTokens;
    tok.out += outputTokens;
    if (cacheReadTokens > 0) tok.cacheRead = (tok.cacheRead ?? 0) + cacheReadTokens;
    if (cacheWriteTokens > 0) tok.cacheWrite = (tok.cacheWrite ?? 0) + cacheWriteTokens;
    this.metrics.tokensByModel[modelRef] = tok;

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
   * Clears the scheduled midnight-summary timer (test hygiene — review K2,
   * 2026-09-27: every `new CostTracker()` schedules an unref'd timeout that
   * fires logSummary hours later; harmless, but tests shouldn't leak them).
   */
  dispose(): void {
    if (this.logInterval) {
      clearTimeout(this.logInterval);
      this.logInterval = null;
    }
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
   * Full-audit /router cost report (owner decision 2026-09-27: "volle
   * Audittiefe"). Session section lists ALL models — requests, in/out
   * tokens, accumulated marginal cost, billing tier with a sunk marker for
   * subscription prices (the cost_per_m sunk-cost convention — virtual
   * prices, NOT real spend) — sorted by marginal cost desc. Windows section
   * shows persistent token usage 1d/7d/30d (usage_log) with a blended-price
   * estimate, labeled ≈: usage_log records only TOTAL tokens per request,
   * so the honest estimate is tokens × (pIn+pOut)/2 / 1M; models without a
   * known price show tokens only. Deps are injected (metrics module +
   * usage_log windows) to keep CostTracker free of config/cache imports.
   */
  formatCostReport(deps: {
    billingTier: (ref: string) => number;
    windowsAll: () => Record<string, { d1: number; d7: number; d30: number; cacheRead30?: number }>;
    price: (ref: string) => { input: number; output: number } | undefined;
  }): string {
    const uptime = new Date().getTime() - this.startTime.getTime();
    const uptimeHours = (uptime / (1000 * 60 * 60)).toFixed(1);
    const tok = this.metrics.tokensByModel ?? {};
    const models = Object.keys(this.metrics.requestsByModel);

    const fmtK = (n: number): string =>
      n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(1)}M`
        : n >= 1000
          ? `${(n / 1000).toFixed(1)}k`
          : String(n);
    const fmtCost = (n: number): string =>
      n === 0 ? '$0.0' : n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`;
    const tierLabel = (ref: string): string => {
      const t = deps.billingTier(ref);
      if (t === 0) return 'free';
      if (t === 1) return 'sub (sunk)';
      if (t === 2) return 'local';
      return 'payg';
    };

    const lines: string[] = [`=== Cost Tracker (Session, ${uptimeHours}h) ===`];

    // Session table — only when this process actually served requests.
    if (models.length === 0) {
      lines.push('No requests yet this session.');
    } else {
      // Phase 5a: cache reads are reported separately from `in` (which is the
      // fresh, uncached input), so the share is cacheRead / everything read.
      const cr = this.metrics.totalCacheReadTokens ?? 0;
      const cw = this.metrics.totalCacheWriteTokens ?? 0;
      const ctxRead = this.metrics.totalInputTokens + cr + cw;
      const cacheNote =
        cr + cw > 0
          ? `, cache read ${fmtK(cr)} (${ctxRead > 0 ? Math.round((cr / ctxRead) * 100) : 0}%), write ${fmtK(cw)}`
          : '';
      lines.push(
        `Total: $${this.metrics.totalCost.toFixed(6)} (in ${fmtK(this.metrics.totalInputTokens)}, out ${fmtK(this.metrics.totalOutputTokens)}${cacheNote}, ${Object.values(this.metrics.requestsByModel).reduce((a, b) => a + b, 0)} req)`,
        ``,
        `${'Model'.padEnd(30)} ${'Req'.padStart(3)} ${'In/Out'.padStart(6)}/${''.padEnd(6)} ${'Marginal'.padStart(9)}  Tier`
      );
      const rows = models
        .map((ref) => ({ ref, cost: this.metrics.costByModel[ref] ?? 0 }))
        .sort((a, b) => b.cost - a.cost);
      for (const { ref, cost } of rows) {
        const t = tok[ref] ?? { in: 0, out: 0 };
        lines.push(
          `${ref.slice(0, 30).padEnd(30)} ${String(this.metrics.requestsByModel[ref]).padStart(3)} ${fmtK(t.in).padStart(6)}/${fmtK(t.out).padEnd(6)} ${fmtCost(cost).padStart(9)}  ${tierLabel(ref)}`
        );
      }
    }

    // Windows (persistent usage_log) + blended estimate. Keyed by the refs
    // that actually HAVE logged usage (session models ∪ usage_log refs), so
    // the persistent half is visible even right after a restart when the
    // session table is still empty (review I1: per-model lookups over an
    // empty session table hid the windows entirely).
    const win = deps.windowsAll();
    const winRefs = [...new Set([...models, ...Object.keys(win)])].sort(
      (a, b) => (win[b]?.d30 ?? 0) - (win[a]?.d30 ?? 0)
    );
    if (winRefs.length > 0) {
      lines.push(``, `--- Windows (usage_log; ≈ = blended-price estimate, cache reads excluded) ---`);
      lines.push(
        `${'Model'.padEnd(28)} ${'1d'.padStart(7)} ${'7d'.padStart(9)} ${'30d'.padStart(9)} ${'Cache30d'.padStart(8)}  ≈30d`
      );
      for (const ref of winRefs) {
        const w = win[ref] ?? { d1: 0, d7: 0, d30: 0 };
        const cacheShare = w.d30 > 0 && w.cacheRead30 ? `${Math.round((w.cacheRead30 / w.d30) * 100)}%` : '-';
        const price = deps.price(ref);
        // Cache reads are billed far below list price, so the blended list
        // estimate covers only the non-cacheRead tokens (Phase 5a).
        const billable = Math.max(0, w.d30 - (w.cacheRead30 ?? 0));
        const est =
          price && w.d30 > 0
            ? `≈$${((billable * (price.input + price.output) / 2) / 1_000_000).toFixed(4)}`
            : '-';
        lines.push(
          `${ref.slice(0, 28).padEnd(28)} ${fmtK(w.d1).padStart(7)} ${fmtK(w.d7).padStart(9)} ${fmtK(w.d30).padStart(9)} ${cacheShare.padStart(8)}  ${est}`
        );
      }
    }
    return lines.join('\n');
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
