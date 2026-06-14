/**
 * Integrationstests für das Kostenstufen-System
 * Testet die Integration von cost-tiers.ts mit dem Router
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Direkter Import der Funktionen (ohne Router-Klasse)
import {
  getModelCostTier,
  modelFitsCostTier,
  getCostTierForCategory,
  getGroupForCategory,
  CATEGORY_TO_COST_TIER,
  CATEGORY_TO_GROUP,
  DEFAULT_COST_TIERS
} from '../src/cost-tiers.js';

// Mock der Metrics-Funktionen
vi.mock('../src/metrics.js', () => ({
  lookupPrice: vi.fn(),
  effCost: vi.fn()
}));

import { lookupPrice, effCost } from '../src/metrics.js';

const mockLookupPrice = lookupPrice as vi.Mock;
const mockEffCost = effCost as vi.Mock;

describe('Cost Tiers Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock für lookupPrice
    mockLookupPrice.mockImplementation((ref: string) => {
      const priceMap: Record<string, { input: number; output: number }> = {
        // Kostenlose Modelle
        'openrouter/qwen/qwen3-4b:free': { input: 0, output: 0 },
        'openrouter/google/gemma-3-4b-it:free': { input: 0, output: 0 },
        'ollama/gemma4:12b-mlx': { input: 0, output: 0 },
        
        // Budget-Modelle (input <= 0.5)
        'openai/gpt-4o-mini': { input: 0.15, output: 0.3 },
        'anthropic/claude-3-haiku': { input: 0.25, output: 0.5 },
        
        // Premium-Modelle (input > 0.5 ODER effCost > 0.1)
        'anthropic/claude-3-sonnet': { input: 0.6, output: 1.4 },  // effCost = 1.0
        'openai/gpt-4o': { input: 0.6, output: 1.6 },             // effCost = 1.1
        'mistral/mistral-medium-3.5': { input: 0.6, output: 1.4 } // effCost = 1.0
      };
      return priceMap[ref] ?? null;
    });

    // Mock für effCost
    mockEffCost.mockImplementation((ref: string) => {
      const price = mockLookupPrice(ref);
      if (!price) return 0;
      return (price.input + price.output) / 2;
    });
  });

  describe('Complete Routing Flow', () => {
    const staticFreeModels = [
      'openrouter/qwen/qwen3-4b:free',
      'openrouter/google/gemma-3-4b-it:free',
      'openrouter/meta-llama/llama-3.3-70b-instruct:free'
    ];

    it('should route trivial request to free model', () => {
      const category = 'trivial';
      const costTier = getCostTierForCategory(category);
      const group = getGroupForCategory(category);

      expect(costTier).toBe('free');
      expect(group).toBe('trivial');

      // Prüfe, dass kostenlose Modelle zur free-Kostenstufe passen
      const freeModel = 'openrouter/qwen/qwen3-4b:free';
      const fits = modelFitsCostTier(freeModel, 'free', DEFAULT_COST_TIERS.free, staticFreeModels);
      expect(fits).toBe(true);
    });

    it('should route simple request to free model', () => {
      const category = 'simple';
      const costTier = getCostTierForCategory(category);
      const group = getGroupForCategory(category);

      expect(costTier).toBe('free');
      expect(group).toBe('simple');

      const freeModel = 'openrouter/google/gemma-3-4b-it:free';
      const fits = modelFitsCostTier(freeModel, 'free', DEFAULT_COST_TIERS.free, staticFreeModels);
      expect(fits).toBe(true);
    });

    it('should route code_simple request to free model', () => {
      const category = 'code_simple';
      const costTier = getCostTierForCategory(category);
      const group = getGroupForCategory(category);

      expect(costTier).toBe('free');
      expect(group).toBe('simple');
    });

    it('should route standard request to budget model', () => {
      const category = 'standard';
      const costTier = getCostTierForCategory(category);
      const group = getGroupForCategory(category);

      expect(costTier).toBe('budget');
      expect(group).toBe('standard');

      // Budget-Modelle sollten zur budget-Kostenstufe passen
      const budgetModel = 'openai/gpt-4o-mini';
      const fits = modelFitsCostTier(budgetModel, 'budget', DEFAULT_COST_TIERS.budget, staticFreeModels);
      expect(fits).toBe(true);
    });

    it('should route code_complex request to premium model', () => {
      const category = 'code_complex';
      const costTier = getCostTierForCategory(category);
      const group = getGroupForCategory(category);

      expect(costTier).toBe('premium');
      expect(group).toBe('complex');

      // Premium-Modelle sollten zur premium-Kostenstufe passen
      const premiumModel = 'anthropic/claude-3-sonnet';
      const fits = modelFitsCostTier(premiumModel, 'premium', DEFAULT_COST_TIERS.premium, staticFreeModels);
      expect(fits).toBe(true);
    });

    it('should route design request to premium model', () => {
      const category = 'design';
      const costTier = getCostTierForCategory(category);
      const group = getGroupForCategory(category);

      expect(costTier).toBe('premium');
      expect(group).toBe('complex');
    });

    it('should route planning request to premium model', () => {
      const category = 'planning';
      const costTier = getCostTierForCategory(category);
      const group = getGroupForCategory(category);

      expect(costTier).toBe('premium');
      expect(group).toBe('complex');
    });

    it('should route exploration request to free model', () => {
      const category = 'exploration';
      const costTier = getCostTierForCategory(category);
      const group = getGroupForCategory(category);

      expect(costTier).toBe('free');
      expect(group).toBe('scout');
    });

    it('should route fallback request to budget model', () => {
      const category = 'fallback';
      const costTier = getCostTierForCategory(category);
      const group = getGroupForCategory(category);

      expect(costTier).toBe('budget');
      expect(group).toBe('standard');
    });
  });

  describe('Model Cost Tier Detection', () => {
    const staticFreeModels = [
      'openrouter/qwen/qwen3-4b:free',
      'openrouter/google/gemma-3-4b-it:free'
    ];

    it('should detect free tier for static free models', () => {
      const tier = getModelCostTier('openrouter/qwen/qwen3-4b:free', staticFreeModels);
      expect(tier).toBe('free');
    });

    it('should detect free tier for zero-cost models', () => {
      const tier = getModelCostTier('ollama/gemma4:12b-mlx', staticFreeModels);
      expect(tier).toBe('free');
    });

    it('should detect budget tier for low-cost models', () => {
      const tier = getModelCostTier('openai/gpt-4o-mini', staticFreeModels);
      expect(tier).toBe('budget');
    });

    it('should detect premium tier for high-cost models', () => {
      const tier = getModelCostTier('anthropic/claude-3-sonnet', staticFreeModels);
      expect(tier).toBe('premium');
    });
  });

  describe('Cost Tier Filtering', () => {
    const staticFreeModels = [
      'openrouter/qwen/qwen3-4b:free',
      'openrouter/google/gemma-3-4b-it:free'
    ];

    it('should accept free models for free tier', () => {
      const models = [
        'openrouter/qwen/qwen3-4b:free',
        'openrouter/google/gemma-3-4b-it:free',
        'ollama/gemma4:12b-mlx'
      ];

      models.forEach(model => {
        const fits = modelFitsCostTier(model, 'free', DEFAULT_COST_TIERS.free, staticFreeModels);
        expect(fits, `Model ${model} should fit free tier`).toBe(true);
      });
    });

    it('should reject non-free models for free tier', () => {
      const models = [
        'openai/gpt-4o-mini',
        'anthropic/claude-3-haiku',
        'anthropic/claude-3-sonnet'
      ];

      models.forEach(model => {
        const fits = modelFitsCostTier(model, 'free', DEFAULT_COST_TIERS.free, staticFreeModels);
        expect(fits, `Model ${model} should NOT fit free tier`).toBe(false);
      });
    });

    it('should accept free and budget models for budget tier', () => {
      const models = [
        'openrouter/qwen/qwen3-4b:free',
        'openai/gpt-4o-mini',
        'anthropic/claude-3-haiku'
      ];

      models.forEach(model => {
        const fits = modelFitsCostTier(model, 'budget', DEFAULT_COST_TIERS.budget, staticFreeModels);
        expect(fits, `Model ${model} should fit budget tier`).toBe(true);
      });
    });

    it('should reject premium models for budget tier', () => {
      const models = [
        'anthropic/claude-3-sonnet',
        'openai/gpt-4o'
      ];

      models.forEach(model => {
        const fits = modelFitsCostTier(model, 'budget', DEFAULT_COST_TIERS.budget, staticFreeModels);
        expect(fits, `Model ${model} should NOT fit budget tier`).toBe(false);
      });
    });

    it('should accept all models for premium tier', () => {
      const models = [
        'openrouter/qwen/qwen3-4b:free',
        'openai/gpt-4o-mini',
        'anthropic/claude-3-haiku',
        'anthropic/claude-3-sonnet',
        'mistral/mistral-medium-3.5'
      ];

      models.forEach(model => {
        const fits = modelFitsCostTier(model, 'premium', DEFAULT_COST_TIERS.premium, staticFreeModels);
        expect(fits, `Model ${model} should fit premium tier`).toBe(true);
      });
    });
  });

  describe('Category Mappings', () => {
    it('should have all required categories in CATEGORY_TO_COST_TIER', () => {
      const requiredCategories = [
        'trivial', 'simple', 'code_simple', 'standard', 
        'code_complex', 'design', 'planning', 'exploration', 'fallback'
      ];

      requiredCategories.forEach(category => {
        expect(CATEGORY_TO_COST_TIER).toHaveProperty(category);
      });
    });

    it('should have all required categories in CATEGORY_TO_GROUP', () => {
      const requiredCategories = [
        'trivial', 'simple', 'code_simple', 'standard', 
        'code_complex', 'design', 'planning', 'exploration', 'fallback'
      ];

      requiredCategories.forEach(category => {
        expect(CATEGORY_TO_GROUP).toHaveProperty(category);
      });
    });

    it('should map categories consistently', () => {
      // Prüfe, dass die Mappings sinnvoll sind
      expect(CATEGORY_TO_COST_TIER.trivial).toBe('free');
      expect(CATEGORY_TO_COST_TIER.simple).toBe('free');
      expect(CATEGORY_TO_COST_TIER.code_simple).toBe('free');
      expect(CATEGORY_TO_COST_TIER.standard).toBe('budget');
      expect(CATEGORY_TO_COST_TIER.code_complex).toBe('premium');
      expect(CATEGORY_TO_COST_TIER.design).toBe('premium');
      expect(CATEGORY_TO_COST_TIER.planning).toBe('premium');
      expect(CATEGORY_TO_COST_TIER.exploration).toBe('free');
      expect(CATEGORY_TO_COST_TIER.fallback).toBe('budget');
    });
  });

  describe('Cost Savings Calculations', () => {
    // Diese Tests sind bereits in cost-tiers.test.ts
    // Hier nur Integrationstests

    it('should calculate savings for typical usage', () => {
      // Angenommen: 100 Anfragen, 90 kostenlos, 10 mit $0.50 Kosten
      const totalRequests = 100;
      const freeRequests = 90;
      const avgCostPerRequest = 0.50;

      const savings = freeRequests * avgCostPerRequest;
      const totalCost = (totalRequests - freeRequests) * avgCostPerRequest;
      const savingsPercentage = (savings / (savings + totalCost)) * 100;

      expect(savings).toBe(45); // 90 * 0.50
      expect(totalCost).toBe(5);   // 10 * 0.50
      expect(savingsPercentage).toBe(90); // 45 / (45 + 5) * 100
    });
  });
});
