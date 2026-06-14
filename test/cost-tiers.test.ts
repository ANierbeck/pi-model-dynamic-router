/**
 * Tests für das Kostenstufen-System (src/cost-tiers.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getModelCostTier,
  modelFitsCostTier,
  getCostTierForCategory,
  getGroupForCategory,
  calculateEstimatedSavings,
  calculateSavingsPercentage,
  validateCostTiersConfig,
  getCostTiersFromConfig,
  isValidCostTiersConfig,
  DEFAULT_COST_TIERS,
  CostTier
} from '../src/cost-tiers.js';

// Mock der Metrics-Funktionen
vi.mock('../src/metrics.js', () => ({
  lookupPrice: vi.fn(),
  effCost: vi.fn()
}));

import { lookupPrice, effCost } from '../src/metrics.js';

const mockLookupPrice = lookupPrice as vi.Mock;
const mockEffCost = effCost as vi.Mock;

describe('Cost Tiers System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Standard-Mock für lookupPrice
    // WICHTIG: input <= 0.5 für Budget, input > 0.5 für Premium
    mockLookupPrice.mockImplementation((ref: string) => {
      const priceMap: Record<string, { input: number; output: number }> = {
        // Kostenlose Modelle
        'openrouter/qwen/qwen3-4b:free': { input: 0, output: 0 },
        'openrouter/google/gemma-3-4b-it:free': { input: 0, output: 0 },
        'ollama/gemma4:12b-mlx': { input: 0, output: 0 },
        
        // Budget-Modelle (input <= 0.5)
        'openai/gpt-4o-mini': { input: 0.15, output: 0.3 },  // input <= 0.5
        'anthropic/claude-3-haiku': { input: 0.25, output: 0.5 }, // input <= 0.5
        
        // Premium-Modelle (input > 0.5)
        // WICHTIG: effCost = (input + output)/2 muss <= max_cost_per_request (1.0) sein
        'anthropic/claude-3-sonnet': { input: 0.6, output: 1.4 },  // effCost = 1.0
        'openai/gpt-4o': { input: 0.5, output: 1.5 },              // effCost = 1.0
        'mistral/mistral-medium-3.5': { input: 0.6, output: 1.4 } // effCost = 1.0
      };
      return priceMap[ref] ?? null;
    });
    
    // Standard-Mock für effCost
    mockEffCost.mockImplementation((ref: string) => {
      const price = mockLookupPrice(ref);
      if (!price) return 0;
      return (price.input + price.output) / 2;
    });
  });

  describe('getModelCostTier', () => {
    it('should return free for models in staticFreeModels list', () => {
      const staticFreeModels = ['openrouter/qwen/qwen3-4b:free'];
      const tier = getModelCostTier('openrouter/qwen/qwen3-4b:free', staticFreeModels);
      expect(tier).toBe('free');
    });

    it('should return free for models with zero cost', () => {
      const tier = getModelCostTier('ollama/gemma4:12b-mlx', []);
      expect(tier).toBe('free');
    });

    it('should return budget for models with low cost', () => {
      // openai/gpt-4o-mini hat input: 0.15, output: 0.6
      // Budget-Schwelle ist 0.5 für input
      // Da input (0.15) <= 0.5, sollte es budget sein
      const tier = getModelCostTier('openai/gpt-4o-mini', []);
      expect(tier).toBe('budget');
    });

    it('should return premium for expensive models', () => {
      const tier = getModelCostTier('anthropic/claude-3-sonnet', []);
      expect(tier).toBe('premium');
    });

    it('should return free for unknown models with zero price', () => {
      mockLookupPrice.mockReturnValueOnce({ input: 0, output: 0 });
      const tier = getModelCostTier('unknown/free-model', []);
      expect(tier).toBe('free');
    });

    it('should return premium for models with high price', () => {
      // Modelle mit input > 0.5 sollten als premium klassifiziert werden
      mockLookupPrice.mockReturnValueOnce({ input: 1.0, output: 2.0 });
      const tier = getModelCostTier('unknown/expensive-model', []);
      expect(tier).toBe('premium');
    });
  });

  describe('modelFitsCostTier', () => {
    const staticFreeModels = [
      'openrouter/qwen/qwen3-4b:free',
      'openrouter/google/gemma-3-4b-it:free'
    ];

    describe('free tier', () => {
      it('should accept models in staticFreeModels', () => {
        const fits = modelFitsCostTier(
          'openrouter/qwen/qwen3-4b:free',
          'free',
          DEFAULT_COST_TIERS.free,
          staticFreeModels
        );
        expect(fits).toBe(true);
      });

      it('should accept models with zero cost', () => {
        const fits = modelFitsCostTier(
          'ollama/gemma4:12b-mlx',
          'free',
          DEFAULT_COST_TIERS.free,
          []
        );
        expect(fits).toBe(true);
      });

      it('should reject models with non-zero cost', () => {
        const fits = modelFitsCostTier(
          'openai/gpt-4o-mini',
          'free',
          DEFAULT_COST_TIERS.free,
          []
        );
        expect(fits).toBe(false);
      });
    });

    describe('budget tier', () => {
      it('should accept free models', () => {
        const fits = modelFitsCostTier(
          'openrouter/qwen/qwen3-4b:free',
          'budget',
          DEFAULT_COST_TIERS.budget,
          staticFreeModels
        );
        expect(fits).toBe(true);
      });

      it('should accept models within cost limits', () => {
        // openai/gpt-4o-mini hat input: 0.15, output: 0.3
        // Budget-Schwelle: max_cost_per_m: 0.5
        // Da input (0.15) <= 0.5, sollte es passen
        const fits = modelFitsCostTier(
          'openai/gpt-4o-mini',
          'budget',
          DEFAULT_COST_TIERS.budget,
          []
        );
        expect(fits).toBe(true);
      });

      it('should reject models above cost limits', () => {
        const fits = modelFitsCostTier(
          'anthropic/claude-3-sonnet',
          'budget',
          DEFAULT_COST_TIERS.budget,
          []
        );
        expect(fits).toBe(false);
      });
    });

    describe('premium tier', () => {
      it('should accept all models', () => {
        const models = [
          'openrouter/qwen/qwen3-4b:free',  // Kostenlos
          'openai/gpt-4o-mini',             // Budget (input: 0.15 <= 0.5)
          'anthropic/claude-3-sonnet'       // Premium (input: 0.6 > 0.5)
        ];
        
        models.forEach(model => {
          const fits = modelFitsCostTier(
            model,
            'premium',
            DEFAULT_COST_TIERS.premium,
            staticFreeModels
          );
          // Alle Modelle sollten zu Premium passen
          expect(fits, `Model ${model} should fit premium tier`).toBe(true);
        });
      });
    });
  });

  describe('CATEGORY_TO_COST_TIER Mapping', () => {
    it('should map trivial to free', () => {
      expect(getCostTierForCategory('trivial')).toBe('free');
    });

    it('should map simple to free', () => {
      expect(getCostTierForCategory('simple')).toBe('free');
    });

    it('should map code_simple to free', () => {
      expect(getCostTierForCategory('code_simple')).toBe('free');
    });

    it('should map standard to budget', () => {
      expect(getCostTierForCategory('standard')).toBe('budget');
    });

    it('should map code_complex to premium', () => {
      expect(getCostTierForCategory('code_complex')).toBe('premium');
    });

    it('should map design to premium', () => {
      expect(getCostTierForCategory('design')).toBe('premium');
    });

    it('should map planning to premium', () => {
      expect(getCostTierForCategory('planning')).toBe('premium');
    });

    it('should map exploration to free', () => {
      expect(getCostTierForCategory('exploration')).toBe('free');
    });

    it('should map fallback to budget', () => {
      expect(getCostTierForCategory('fallback')).toBe('budget');
    });
  });

  describe('CATEGORY_TO_GROUP Mapping', () => {
    it('should map trivial to scout group', () => {
      expect(getGroupForCategory('trivial')).toBe('scout');
    });

    it('should map simple to operational group', () => {
      expect(getGroupForCategory('simple')).toBe('operational');
    });

    it('should map code_simple to operational group', () => {
      expect(getGroupForCategory('code_simple')).toBe('operational');
    });

    it('should map standard to operational group', () => {
      expect(getGroupForCategory('standard')).toBe('operational');
    });

    it('should map code_complex to tactical group', () => {
      expect(getGroupForCategory('code_complex')).toBe('tactical');
    });

    it('should map design to tactical group', () => {
      expect(getGroupForCategory('design')).toBe('tactical');
    });

    it('should map planning to tactical group', () => {
      expect(getGroupForCategory('planning')).toBe('tactical');
    });

    it('should map exploration to scout group', () => {
      expect(getGroupForCategory('exploration')).toBe('scout');
    });

    it('should map fallback to tactical group', () => {
      expect(getGroupForCategory('fallback')).toBe('tactical');
    });
  });

  describe('Cost Savings Calculations', () => {
    describe('calculateEstimatedSavings', () => {
      it('should return 0 for 0 total requests', () => {
        const savings = calculateEstimatedSavings(0, 10, 0.5);
        expect(savings).toBe(0);
      });

      it('should return 0 for 0 average cost', () => {
        const savings = calculateEstimatedSavings(100, 50, 0);
        expect(savings).toBe(0);
      });

      it('should calculate savings correctly', () => {
        const savings = calculateEstimatedSavings(100, 50, 0.5);
        expect(savings).toBe(25); // 50 * 0.5 = 25
      });

      it('should calculate savings for all free requests', () => {
        const savings = calculateEstimatedSavings(100, 100, 0.5);
        expect(savings).toBe(50); // 100 * 0.5 = 50
      });
    });

    describe('calculateSavingsPercentage', () => {
      it('should return 0 for 0 total cost and 0 savings', () => {
        const percentage = calculateSavingsPercentage(0, 0);
        expect(percentage).toBe(0);
      });

      it('should calculate percentage correctly', () => {
        const percentage = calculateSavingsPercentage(25, 75);
        expect(percentage).toBe(75); // 75 / (25 + 75) * 100 = 75%
      });

      it('should return 100 for all savings', () => {
        const percentage = calculateSavingsPercentage(0, 100);
        expect(percentage).toBe(100);
      });

      it('should return 0 for all cost', () => {
        const percentage = calculateSavingsPercentage(100, 0);
        expect(percentage).toBe(0);
      });

      it('should handle 50/50 split', () => {
        const percentage = calculateSavingsPercentage(50, 50);
        expect(percentage).toBe(50);
      });
    });
  });

  describe('validateCostTiersConfig', () => {
    it('should return empty array for valid config', () => {
      const errors = validateCostTiersConfig(DEFAULT_COST_TIERS);
      expect(errors).toEqual([]);
    });

    it('should detect unknown cost tier', () => {
      const config = { ...DEFAULT_COST_TIERS, unknown: {} };
      const errors = validateCostTiersConfig(config as any);
      expect(errors).toContain('Unknown cost tier: unknown');
    });

    it('should detect negative max_cost_per_m', () => {
      const config = {
        ...DEFAULT_COST_TIERS,
        free: { ...DEFAULT_COST_TIERS.free, max_cost_per_m: -1 }
      };
      const errors = validateCostTiersConfig(config);
      expect(errors).toContain('Invalid max_cost_per_m for free: must be >= 0');
    });

    it('should detect negative max_cost_per_request', () => {
      const config = {
        ...DEFAULT_COST_TIERS,
        budget: { ...DEFAULT_COST_TIERS.budget, max_cost_per_request: -0.1 }
      };
      const errors = validateCostTiersConfig(config);
      expect(errors).toContain('Invalid max_cost_per_request for budget: must be >= 0');
    });

    it('should detect negative min_gdpval', () => {
      const config = {
        ...DEFAULT_COST_TIERS,
        premium: { ...DEFAULT_COST_TIERS.premium, min_gdpval: -100 }
      };
      const errors = validateCostTiersConfig(config);
      expect(errors).toContain('Invalid min_gdpval for premium: must be >= 0');
    });
  });

  describe('getCostTiersFromConfig', () => {
    it('should return default config for empty config', () => {
      const config = { model_groups: {} };
      const tiers = getCostTiersFromConfig(config as any);
      expect(tiers).toEqual(DEFAULT_COST_TIERS);
    });

    it('should return custom config when valid', () => {
      const customConfig = {
        cost_tiers: {
          free: {
            id: 'free',
            description: 'Custom free tier',
            max_cost_per_m: 0,
            max_cost_per_request: 0,
            min_gdpval: 0,
            preferred_providers: ['custom']
          },
          budget: DEFAULT_COST_TIERS.budget,
          premium: DEFAULT_COST_TIERS.premium
        },
        model_groups: {}
      };
      const tiers = getCostTiersFromConfig(customConfig as any);
      expect(tiers.free.description).toBe('Custom free tier');
      expect(tiers.free.preferred_providers).toEqual(['custom']);
    });

    it('should return default config for invalid custom config', () => {
      const invalidConfig = {
        cost_tiers: {
          free: DEFAULT_COST_TIERS.free,
          // budget fehlt
          premium: DEFAULT_COST_TIERS.premium
        },
        model_groups: {}
      };
      const tiers = getCostTiersFromConfig(invalidConfig as any);
      expect(tiers).toEqual(DEFAULT_COST_TIERS);
    });
  });

  describe('isValidCostTiersConfig', () => {
    it('should return true for valid config', () => {
      expect(isValidCostTiersConfig(DEFAULT_COST_TIERS)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isValidCostTiersConfig(null)).toBe(false);
    });

    it('should return false for non-object', () => {
      expect(isValidCostTiersConfig('not an object')).toBe(false);
    });

    it('should return false for missing tier', () => {
      const config = {
        free: DEFAULT_COST_TIERS.free,
        premium: DEFAULT_COST_TIERS.premium
        // budget fehlt
      };
      expect(isValidCostTiersConfig(config)).toBe(false);
    });

    it('should return false for invalid tier config', () => {
      const config = {
        free: DEFAULT_COST_TIERS.free,
        budget: { max_cost_per_m: 'invalid' } as any,
        premium: DEFAULT_COST_TIERS.premium
      };
      expect(isValidCostTiersConfig(config)).toBe(false);
    });
  });

  describe('DEFAULT_COST_TIERS', () => {
    it('should have all required tiers', () => {
      expect(DEFAULT_COST_TIERS).toHaveProperty('free');
      expect(DEFAULT_COST_TIERS).toHaveProperty('budget');
      expect(DEFAULT_COST_TIERS).toHaveProperty('premium');
    });

    it('should have correct free tier config', () => {
      expect(DEFAULT_COST_TIERS.free.max_cost_per_m).toBe(0);
      expect(DEFAULT_COST_TIERS.free.max_cost_per_request).toBe(0);
      expect(DEFAULT_COST_TIERS.free.min_gdpval).toBe(0);
    });

    it('should have correct budget tier config', () => {
      expect(DEFAULT_COST_TIERS.budget.max_cost_per_m).toBe(0.5);
      expect(DEFAULT_COST_TIERS.budget.max_cost_per_request).toBe(0.1);
      expect(DEFAULT_COST_TIERS.budget.min_gdpval).toBe(300);
    });

    it('should have correct premium tier config', () => {
      expect(DEFAULT_COST_TIERS.premium.max_cost_per_m).toBe(2.0);
      expect(DEFAULT_COST_TIERS.premium.max_cost_per_request).toBe(1.0);
      expect(DEFAULT_COST_TIERS.premium.min_gdpval).toBe(600);
    });
  });
});
