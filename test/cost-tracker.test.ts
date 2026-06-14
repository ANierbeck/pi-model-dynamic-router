/**
 * Tests für das Cost-Tracking-System
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CostTracker } from '../src/cost-tracker.js';
import * as metricsModule from '../src/metrics.js';

// Mock für lookupPrice
vi.mock('../src/metrics.js', () => ({
  lookupPrice: vi.fn(),
}));

// Mock für getModelCostTier
vi.mock('../src/cost-tiers.js', () => ({
  getModelCostTier: vi.fn(),
}));

const mockLookupPrice = vi.mocked(metricsModule.lookupPrice);
const mockGetModelCostTier = vi.mocked((await import('../src/cost-tiers.js')).getModelCostTier);

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Standard-Mock für lookupPrice
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
    
    // Standard-Mock für getModelCostTier
    mockGetModelCostTier.mockImplementation((ref: string) => {
      const tierMap: Record<string, 'free' | 'budget' | 'premium'> = {
        'openrouter/qwen/qwen3-4b:free': 'free',
        'openrouter/google/gemma-3-4b-it:free': 'free',
        'anthropic/claude-3-sonnet': 'premium',
        'openai/gpt-4o-mini': 'budget',
        'openai/gpt-4o': 'premium',
      };
      return tierMap[ref] ?? 'budget';
    });
    
    tracker = new CostTracker();
    // Deaktiviere die automatische tägliche Zusammenfassung für Tests
    (tracker as any).logInterval = null;
  });

  afterEach(() => {
    // Setze Metriken zurück statt zu zerstören, um Singleton zu erhalten
    tracker.resetMetrics();
  });

  describe('trackRequest', () => {
    it('should track free model requests', () => {
      tracker.trackRequest('openrouter/qwen/qwen3-4b:free', 1000, 500);
      
      const metrics = tracker.getMetrics();
      expect(metrics.totalCost).toBe(0);
      expect(metrics.totalInputTokens).toBe(1000);
      expect(metrics.totalOutputTokens).toBe(500);
      expect(metrics.requestsByTier.free).toBe(1);
      expect(metrics.costByTier.free).toBe(0);
      expect(metrics.requestsByModel['openrouter/qwen/qwen3-4b:free']).toBe(1);
      expect(metrics.costByModel['openrouter/qwen/qwen3-4b:free']).toBe(0);
    });

    it('should track budget model requests', () => {
      tracker.trackRequest('openai/gpt-4o-mini', 1000, 500);
      
      const metrics = tracker.getMetrics();
      // Kosten: (1000 * 0.15 + 500 * 0.3) / 1.000.000 = 0.0003
      expect(metrics.totalCost).toBeCloseTo(0.0003, 6);
      expect(metrics.requestsByTier.budget).toBe(1);
      expect(metrics.costByTier.budget).toBeCloseTo(0.0003, 6);
    });

    it('should track premium model requests', () => {
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);
      
      const metrics = tracker.getMetrics();
      // Kosten: (1000 * 0.6 + 500 * 1.4) / 1.000.000 = 0.0013
      expect(metrics.totalCost).toBeCloseTo(0.0013, 6);
      expect(metrics.requestsByTier.premium).toBe(1);
      expect(metrics.costByTier.premium).toBeCloseTo(0.0013, 6);
    });

    it('should handle models without price info', () => {
      mockLookupPrice.mockReturnValueOnce(null);
      
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      tracker.trackRequest('unknown/model', 1000, 500);
      
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[cost-tracker] No price info for model: unknown/model'
      );
      
      const metrics = tracker.getMetrics();
      expect(metrics.totalCost).toBe(0);
      expect(metrics.totalInputTokens).toBe(0);
      expect(metrics.totalOutputTokens).toBe(0);
      
      consoleWarnSpy.mockRestore();
    });

    it('should accumulate metrics across multiple requests', () => {
      tracker.trackRequest('openrouter/qwen/qwen3-4b:free', 1000, 500);
      tracker.trackRequest('anthropic/claude-3-sonnet', 2000, 1000);
      tracker.trackRequest('openai/gpt-4o-mini', 500, 250);
      
      const metrics = tracker.getMetrics();
      expect(metrics.totalInputTokens).toBe(1000 + 2000 + 500);
      expect(metrics.totalOutputTokens).toBe(500 + 1000 + 250);
      expect(metrics.requestsByTier.free).toBe(1);
      expect(metrics.requestsByTier.premium).toBe(1);
      expect(metrics.requestsByTier.budget).toBe(1);
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
      expect(metrics.requestsByTier.free).toBe(0);
      expect(metrics.requestsByTier.budget).toBe(0);
      expect(metrics.requestsByTier.premium).toBe(0);
    });
  });

  describe('getSummaryJson', () => {
    it('should return valid JSON summary', () => {
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);
      
      const json = tracker.getSummaryJson();
      const summary = JSON.parse(json);
      
      expect(summary.timestamp).toBeDefined();
      expect(summary.uptimeMs).toBeGreaterThanOrEqual(0); // Kann 0 sein, wenn Test sehr schnell läuft
      expect(summary.metrics.totalCost).toBeCloseTo(0.0013, 5);
    });
  });

  describe('logSummary', () => {
    it('should log summary to console', () => {
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);
      
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      tracker.logSummary('Test');
      
      expect(consoleLogSpy).toHaveBeenCalled();
      const logCall = consoleLogSpy.mock.calls[0][0];
      expect(logCall).toContain('[cost-tracker]');
      expect(logCall).toContain('Test');
      expect(logCall).toContain('Total Cost:');
      
      consoleLogSpy.mockRestore();
    });

    it('should reset metrics after logging summary', () => {
      tracker.trackRequest('anthropic/claude-3-sonnet', 1000, 500);
      tracker.logSummary();
      
      const metrics = tracker.getMetrics();
      expect(metrics.totalCost).toBe(0);
    });
  });
});
