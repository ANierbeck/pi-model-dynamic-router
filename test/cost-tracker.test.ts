/**
 * Tests for the Cost-Tracking-System
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CostTracker } from '../src/cost-tracker.js';
import * as metricsModule from '../src/metrics.js';

// Mock lookupPrice — the only external dependency of CostTracker now that
// per-tier accounting (getModelCostTier) was removed with the cost-tier system.
vi.mock('../src/metrics.js', () => ({
  lookupPrice: vi.fn(),
}));

// D2: cost-tracker routes diagnostics through routerLog (file logger), not
// console.*. Mock logger so the opt-in diagnostic tests can assert routerLog
// was called (and console.* was NOT) without touching real log files.
vi.mock('../src/logger.js', () => ({
  routerLog: vi.fn(),
  writeLogLine: vi.fn(),
  appendRawLog: vi.fn(),
  setProjectLogDir: vi.fn(),
}));

const mockLookupPrice = vi.mocked(metricsModule.lookupPrice);
import * as loggerModule from '../src/logger.js';
const mockRouterLog = vi.mocked(loggerModule.routerLog);

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    vi.clearAllMocks();

    // Standard mock for lookupPrice
    mockLookupPrice.mockImplementation((ref: string) => {
      const priceMap: Record<string, { input: number; output: number }> = {
        'openrouter/qwen/qwen3-4b:free': { input: 0, output: 0 },
        'openrouter/google/gemma-3-4b-it:free': { input: 0, output: 0 },
        'anthropic/claude-3-sonnet': { input: 0.6, output: 1.4 },
        'openai/gpt-4o-mini': { input: 0.15, output: 0.3 },
        'openai/gpt-4o': { input: 0.5, output: 1.5 },
      };
      return priceMap[ref] ?? null;
    });

    tracker = new CostTracker();
    // Disable the automatic daily summary for tests
    if ((tracker as any).logInterval) {
      clearTimeout((tracker as any).logInterval);
      (tracker as any).logInterval = null;
    }
  });

  afterEach(() => {
    // Reset metrics instead of destroying, to keep the singleton
    tracker.resetMetrics();
  });

  describe('trackRequest', () => {
    it('should track free model requests', () => {
      tracker.trackRequest('openrouter/qwen/qwen3-4b:free', 1000, 500);

      const metrics = tracker.getMetrics();
      expect(metrics.totalCost).toBe(0);
      expect(metrics.totalInputTokens).toBe(1000);
      expect(metrics.totalOutputTokens).toBe(500);
      expect(metrics.requestsByModel['openrouter/qwen/qwen3-4b:free']).toBe(1);
      expect(metrics.costByModel['openrouter/qwen/qwen3-4b:free']).toBe(0);
    });

    it('should track budget model requests', () => {
      tracker.trackRequest('openai/gpt-4o-mini', 1000, 500);

      const metrics = tracker.getMetrics();
      // Cost: (1000 * 0.15 + 500 * 0.3) / 1,000,000 = 0.0003
      expect(metrics.totalCost).toBeCloseTo(0.0003, 6);
    });

    it('should track premium model requests', () => {
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);

      const metrics = tracker.getMetrics();
      // Cost: (1000 * 0.6 + 500 * 1.4) / 1,000,000 = 0.0013
      expect(metrics.totalCost).toBeCloseTo(0.0013, 6);
    });

    it('does NOT warn on console by default (would corrupt the TUI input prompt)', () => {
      // Regression guard: an unconditional console.warn on every untracked
      // request (common for subscription/local models without a resolvable
      // price) spammed raw stdout, bypassing ctx.ui.notify and landing in
      // the TUI's input field. Silent by default; opt-in via DEBUG_COST_TRACKER.
      mockLookupPrice.mockReturnValueOnce(null);

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      tracker.trackRequest('unknown/model', 1000, 500);

      expect(consoleWarnSpy).not.toHaveBeenCalled();

      const metrics = tracker.getMetrics();
      expect(metrics.totalCost).toBe(0);
      expect(metrics.totalInputTokens).toBe(0);
      expect(metrics.totalOutputTokens).toBe(0);

      consoleWarnSpy.mockRestore();
    });

    it('warns on console when DEBUG_COST_TRACKER=true (opt-in diagnostic)', () => {
      const prev = process.env.DEBUG_COST_TRACKER;
      process.env.DEBUG_COST_TRACKER = 'true';
      mockLookupPrice.mockReturnValueOnce(null);

      // D2: cost-tracker now routes through routerLog (file logger) instead of
      // console.*, so console.warn must NOT be called even when opted in.
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockRouterLog.mockClear();
      tracker.trackRequest('unknown/model', 1000, 500);

      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(mockRouterLog).toHaveBeenCalledWith(
        '[cost-tracker] No price info for model', 'unknown/model'
      );

      consoleWarnSpy.mockRestore();
      if (prev === undefined) delete process.env.DEBUG_COST_TRACKER;
      else process.env.DEBUG_COST_TRACKER = prev;
    });

    it('should accumulate metrics across multiple requests', () => {
      tracker.trackRequest('openrouter/qwen/qwen3-4b:free', 1000, 500);
      tracker.trackRequest('anthropic/claude-3-sonnet', 2000, 1000);
      tracker.trackRequest('openai/gpt-4o-mini', 500, 250);

      const metrics = tracker.getMetrics();
      expect(metrics.totalInputTokens).toBe(1000 + 2000 + 500);
      expect(metrics.totalOutputTokens).toBe(500 + 1000 + 250);
    });
  });

  describe('resetMetrics', () => {
    it('should reset all metrics', () => {
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);

      tracker.resetMetrics();

      const metrics = tracker.getMetrics();
      expect(metrics.totalCost).toBe(0);
      expect(metrics.totalInputTokens).toBe(0);
      expect(metrics.totalOutputTokens).toBe(0);
    });
  });

  describe('getSummaryJson', () => {
    it('should return valid JSON summary', () => {
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);

      const json = tracker.getSummaryJson();
      const summary = JSON.parse(json);

      expect(summary.timestamp).toBeDefined();
      expect(summary.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(summary.metrics.totalCost).toBeCloseTo(0.0013, 5);
    });
  });

  describe('logSummary', () => {
    it('does NOT log to console by default (would corrupt the TUI input prompt)', () => {
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);

      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      tracker.logSummary('Test');

      expect(consoleLogSpy).not.toHaveBeenCalled();

      consoleLogSpy.mockRestore();
    });

    it('logs to console when DEBUG_COST_TRACKER=true (opt-in diagnostic)', () => {
      const prev = process.env.DEBUG_COST_TRACKER;
      process.env.DEBUG_COST_TRACKER = 'true';
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);

      // D2: logSummary now routes through routerLog (file logger) instead of
      // console.*, so console.log must NOT be called even when opted in.
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mockRouterLog.mockClear();
      tracker.logSummary('Test');

      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(mockRouterLog).toHaveBeenCalled();
      const logCall = mockRouterLog.mock.calls[0][0];
      expect(logCall).toContain('[cost-tracker]');
      expect(logCall).toContain('Test');
      expect(logCall).toContain('Total Cost:');

      consoleLogSpy.mockRestore();
      if (prev === undefined) delete process.env.DEBUG_COST_TRACKER;
      else process.env.DEBUG_COST_TRACKER = prev;
    });

    it('should reset metrics after logging summary', () => {
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);
      tracker.logSummary();

      const metrics = tracker.getMetrics();
      expect(metrics.totalCost).toBe(0);
    });
  });

  describe('formatSummary', () => {
    it('returns the summary text WITHOUT resetting metrics (for on-demand display)', () => {
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);

      const text = tracker.formatSummary('Snapshot');
      expect(text).toContain('Snapshot');
      expect(text).toContain('Total Cost:');

      // Metrics must be UNCHANGED — formatSummary is a read-only snapshot.
      const metrics = tracker.getMetrics();
      expect(metrics.totalCost).toBeCloseTo(0.0013, 6);
    });

    it('does not touch console or the log file', () => {
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      tracker.formatSummary();

      expect(consoleLogSpy).not.toHaveBeenCalled();
      consoleLogSpy.mockRestore();
    });

    it('no longer emits a "By Tier" section (cost-tier system removed)', () => {
      // Regression guard: the per-tier breakdown was tied to the cost-tier
      // system (getModelCostTier) which has been removed. The summary must
      // not reference tiers or the removed tiers field.
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);
      const text = tracker.formatSummary();
      expect(text).not.toContain('By Tier');
      expect(text).toContain('By Model');
    });
  });
});
