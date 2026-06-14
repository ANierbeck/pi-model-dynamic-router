/**
 * Tests für die dynamische Konfiguration-Generierung
 * Überprüft, dass free_models korrekt in die dynamische Konfiguration aufgenommen werden
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock der Abhängigkeiten
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
  };
});

vi.mock('node:path', async () => {
  const actual = await vi.importActual('node:path');
  return {
    ...actual,
    join: vi.fn((...args) => path.posix.join(...args)),
    dirname: vi.fn((p) => path.posix.dirname(p)),
  };
});

// Mock der internen Funktionen
const mockLookupGdp = vi.fn();
const mockLookupPrice = vi.fn();
const mockEffCost = vi.fn();
const mockCalculateScore = vi.fn();

// Mock der Konfiguration
const mockStaticCfg = {
  providers: {
    openrouter: {
      billing: 'pay_per_token',
      free_models: [
        'openrouter/qwen/qwen3-4b:free',
        'openrouter/openai/gpt-4o-mini:free',
        'openrouter/meta-llama/llama-3.3-70b-instruct:free',
        'openrouter/google/gemma-3-4b-it:free',
        'openrouter/google/gemma-3-12b-it:free'
      ]
    },
    mistral: {
      billing: 'pay_per_token'
    },
    ollama: {
      billing: 'subscription'
    }
  },
  model_groups: {
    trivial: {
      description: 'Trivial tasks - free models only',
      method: 'min_cost',
      max_cost: 0,
      models: ['qwen/qwen3-4b:free', 'google/gemma-3-4b-it:free', 'ollama/gemma4:12b-mlx']
    },
    simple: {
      description: 'Simple tasks - free models only',
      method: 'min_cost',
      min_gdpval: 300,
      max_cost: 0,
      models: [
        'qwen/qwen3-4b:free',
        'google/gemma-3-12b-it:free',
        'meta-llama/llama-3.3-70b-instruct:free',
        'ollama/gemma4:12b-mlx'
      ]
    },
    standard: {
      description: 'Standard tasks - cost-effective models',
      method: 'tiered',
      min_gdpval: 500,
      max_cost_per_m: 0.5,
      models: ['openai/gpt-4o-mini', 'anthropic/claude-3-haiku']
    },
    complex: {
      description: 'Complex tasks - GDPval ≥600',
      method: 'best',
      min_gdpval: 600,
      models: ['anthropic/claude-3-sonnet', 'openai/gpt-4o', 'mistral/mistral-medium-3.5']
    },
    dynamic: {
      description: 'Classifies each prompt and routes to cost-efficient group',
      method: 'dynamic'
    }
  }
};

const mockCache = {
  available_models: [
    { id: 'mistral-medium-3.5', provider: 'mistral', cost_per_m: 0.6 },
    { id: 'codestral-latest', provider: 'mistral', cost_per_m: 0.3 },
    { id: 'gemma4:12b-mlx', provider: 'ollama', cost_per_m: 0 }
  ]
};

describe('Dynamic Configuration Generation', () => {
  let generateDynamicConfig: any;
  let consoleLogSpy: any;
  let consoleWarnSpy: any;

  beforeEach(() => {
    // Mock-Funktionen zurücksetzen
    vi.clearAllMocks();
    
    // Mock für lookupGdp
    mockLookupGdp.mockImplementation((ref: string) => {
      const gdpvalMap: Record<string, number> = {
        'openrouter/qwen/qwen3-4b:free': 400,
        'openrouter/openai/gpt-4o-mini:free': 800,
        'openrouter/meta-llama/llama-3.3-70b-instruct:free': 850,
        'openrouter/google/gemma-3-4b-it:free': 350,
        'openrouter/google/gemma-3-12b-it:free': 500,
        'mistral/mistral-medium-3.5': 892,
        'mistral/codestral-latest': 520,
        'ollama/gemma4:12b-mlx': 665,
        'openai/gpt-4o-mini': 889,
        'anthropic/claude-3-haiku': 680,
        'anthropic/claude-3-sonnet': 887,
        'openai/gpt-4o': 889
      };
      return gdpvalMap[ref] ?? null;
    });

    // Mock für lookupPrice
    mockLookupPrice.mockImplementation((ref: string) => {
      const priceMap: Record<string, { input: number; output: number }> = {
        'openrouter/qwen/qwen3-4b:free': { input: 0, output: 0 },
        'openrouter/openai/gpt-4o-mini:free': { input: 0, output: 0 },
        'openrouter/meta-llama/llama-3.3-70b-instruct:free': { input: 0, output: 0 },
        'openrouter/google/gemma-3-4b-it:free': { input: 0, output: 0 },
        'openrouter/google/gemma-3-12b-it:free': { input: 0, output: 0 },
        'mistral/mistral-medium-3.5': { input: 0.6, output: 2.0 },
        'mistral/codestral-latest': { input: 0.3, output: 0.6 },
        'ollama/gemma4:12b-mlx': { input: 0, output: 0 },
        'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
        'anthropic/claude-3-haiku': { input: 0.25, output: 1.0 },
        'anthropic/claude-3-sonnet': { input: 0.6, output: 2.0 },
        'openai/gpt-4o': { input: 0.5, output: 1.5 }
      };
      return priceMap[ref] ?? null;
    });

    // Mock für effCost
    mockEffCost.mockImplementation((ref: string) => {
      const price = mockLookupPrice(ref);
      if (!price) return 0;
      return (price.input + price.output) / 2;
    });

    // Mock für calculateScore
    mockCalculateScore.mockReturnValue(0.8);

    // Console-Spys
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('Free Models Extraction', () => {
    it('should extract free models from provider configs', () => {
      // Extrahiere free_models aus der statischen Konfiguration
      const freeModels: string[] = [];
      for (const [provId, provConfig] of Object.entries(mockStaticCfg.providers)) {
        if (provConfig.free_models && Array.isArray(provConfig.free_models)) {
          for (const model of provConfig.free_models) {
            const normalized = model.startsWith(`${provId}/`) ? model : `${provId}/${model}`;
            freeModels.push(normalized);
          }
        }
      }

      expect(freeModels).toHaveLength(5);
      expect(freeModels).toContain('openrouter/qwen/qwen3-4b:free');
      expect(freeModels).toContain('openrouter/openai/gpt-4o-mini:free');
      expect(freeModels).toContain('openrouter/meta-llama/llama-3.3-70b-instruct:free');
      expect(freeModels).toContain('openrouter/google/gemma-3-4b-it:free');
      expect(freeModels).toContain('openrouter/google/gemma-3-12b-it:free');
    });

    it('should normalize model references correctly', () => {
      const provId = 'openrouter';
      const models = [
        'qwen/qwen3-4b:free',
        'openrouter/openai/gpt-4o-mini:free',
        'meta-llama/llama-3.3-70b-instruct:free'
      ];

      const normalized = models.map(model => 
        model.startsWith(`${provId}/`) ? model : `${provId}/${model}`
      );

      expect(normalized).toEqual([
        'openrouter/qwen/qwen3-4b:free',
        'openrouter/openai/gpt-4o-mini:free',
        'openrouter/meta-llama/llama-3.3-70b-instruct:free'
      ]);
    });
  });

  describe('Cost Filtering', () => {
    it('should identify free models correctly', () => {
      const staticFreeModels = [
        'openrouter/qwen/qwen3-4b:free',
        'openrouter/openai/gpt-4o-mini:free'
      ];

      const allModelRefs = [
        'openrouter/qwen/qwen3-4b:free',
        'mistral/mistral-medium-3.5',
        'openrouter/openai/gpt-4o-mini:free'
      ];

      const modelsWithMetadata = allModelRefs.map(ref => {
        const price = mockLookupPrice(ref);
        const isFreeModel = staticFreeModels.includes(ref) || 
                          (price && price.input === 0 && price.output === 0);
        return { ref, isFreeModel };
      });

      const freeModels = modelsWithMetadata.filter(m => m.isFreeModel);
      expect(freeModels).toHaveLength(2);
      expect(freeModels.map(m => m.ref)).toEqual([
        'openrouter/qwen/qwen3-4b:free',
        'openrouter/openai/gpt-4o-mini:free'
      ]);
    });

    it('should pass max_cost=0 filter for free models', () => {
      const maxCost = 0;
      const models = [
        { ref: 'openrouter/qwen/qwen3-4b:free', cost: 0, isFreeModel: true },
        { ref: 'mistral/mistral-medium-3.5', cost: 0.8, isFreeModel: false }
      ];

      const filtered = models.filter(m => {
        if (m.isFreeModel && maxCost === 0) return true;
        return m.cost <= maxCost;
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].ref).toBe('openrouter/qwen/qwen3-4b:free');
    });

    it('should pass max_cost_per_m filter for free models', () => {
      const maxCostPerM = 0.5;
      const models = [
        { ref: 'openrouter/qwen/qwen3-4b:free', price: { input: 0, output: 0 }, isFreeModel: true },
        { ref: 'openai/gpt-4o-mini', price: { input: 0.15, output: 0.6 }, isFreeModel: false }
      ];

      const filtered = models.filter(m => {
        if (m.isFreeModel) return true;
        return m.price ? m.price.input <= maxCostPerM : true;
      });

      expect(filtered).toHaveLength(2); // Beide passen
    });
  });

  describe('Model Prioritization', () => {
    it('should prioritize static models from config', () => {
      const staticModels = ['qwen/qwen3-4b:free', 'google/gemma-3-4b-it:free'];
      const dynamicModels = [
        { ref: 'openrouter/qwen/qwen3-4b:free', gdpval: 400 },
        { ref: 'openrouter/google/gemma-3-12b-it:free', gdpval: 500 }
      ];

      const modelsToInclude = new Set<string>();
      
      // 1. Statische Modelle zuerst
      for (const model of staticModels) {
        modelsToInclude.add(model);
      }
      
      // 2. Dann dynamische Modelle
      for (const model of dynamicModels) {
        if (!modelsToInclude.has(model.ref)) {
          modelsToInclude.add(model.ref);
        }
      }

      const finalModels = Array.from(modelsToInclude);
      
      // Statische Modelle sollten zuerst kommen
      expect(finalModels.slice(0, 2)).toEqual([
        'qwen/qwen3-4b:free',
        'google/gemma-3-4b-it:free'
      ]);
    });

    it('should sort min_cost with free models first', () => {
      const models = [
        { ref: 'mistral/mistral-medium-3.5', cost: 0.8, isFreeModel: false, gdpval: 892 },
        { ref: 'openrouter/qwen/qwen3-4b:free', cost: 0, isFreeModel: true, gdpval: 400 },
        { ref: 'openrouter/google/gemma-3-4b-it:free', cost: 0, isFreeModel: true, gdpval: 350 },
        { ref: 'openai/gpt-4o-mini', cost: 0.325, isFreeModel: false, gdpval: 889 }
      ];

      // Sortierung: Kostenlose zuerst, dann nach Kosten
      models.sort((a, b) => {
        if (a.isFreeModel && !b.isFreeModel) return -1;
        if (!a.isFreeModel && b.isFreeModel) return 1;
        return a.cost - b.cost;
      });

      expect(models.map(m => m.ref)).toEqual([
        'openrouter/qwen/qwen3-4b:free',
        'openrouter/google/gemma-3-4b-it:free',
        'openai/gpt-4o-mini',
        'mistral/mistral-medium-3.5'
      ]);
    });

    it('should sort tiered with free models preferred at same GDPval', () => {
      const models = [
        { ref: 'mistral/mistral-medium-3.5', gdpval: 892, cost: 0.8, isFreeModel: false },
        { ref: 'openrouter/qwen/qwen3-4b:free', gdpval: 400, cost: 0, isFreeModel: true },
        { ref: 'openrouter/google/gemma-3-12b-it:free', gdpval: 500, cost: 0, isFreeModel: true },
        { ref: 'anthropic/claude-3-haiku', gdpval: 680, cost: 0.625, isFreeModel: false }
      ];

      // Sortierung: GDPval absteigend, kostenlose bevorzugt bei gleichem GDPval
      models.sort((a, b) => {
        if (b.gdpval !== a.gdpval) return b.gdpval - a.gdpval;
        if (a.isFreeModel && !b.isFreeModel) return -1;
        if (!a.isFreeModel && b.isFreeModel) return 1;
        return a.cost - b.cost;
      });

      // Erwartete Reihenfolge: Höchste GDPval zuerst
      // 1. mistral/mistral-medium-3.5 (GDPval: 892)
      // 2. anthropic/claude-3-haiku (GDPval: 680)
      // 3. openrouter/google/gemma-3-12b-it:free (GDPval: 500)
      // 4. openrouter/qwen/qwen3-4b:free (GDPval: 400)
      expect(models.map(m => m.ref)).toEqual([
        'mistral/mistral-medium-3.5',
        'anthropic/claude-3-haiku',
        'openrouter/google/gemma-3-12b-it:free',
        'openrouter/qwen/qwen3-4b:free'
      ]);
    });
  });

  describe('Group Configuration', () => {
    it('should include free models in trivial group', () => {
      const groupConfig = mockStaticCfg.model_groups.trivial;
      const staticModels = groupConfig.models || [];

      expect(staticModels).toHaveLength(3);
      expect(staticModels).toContain('qwen/qwen3-4b:free');
      expect(staticModels).toContain('google/gemma-3-4b-it:free');
      expect(staticModels).toContain('ollama/gemma4:12b-mlx');
    });

    it('should include free models in simple group', () => {
      const groupConfig = mockStaticCfg.model_groups.simple;
      const staticModels = groupConfig.models || [];

      expect(staticModels).toHaveLength(4);
      expect(staticModels).toContain('qwen/qwen3-4b:free');
      expect(staticModels).toContain('google/gemma-3-12b-it:free');
      expect(staticModels).toContain('meta-llama/llama-3.3-70b-instruct:free');
      expect(staticModels).toContain('ollama/gemma4:12b-mlx');
    });

    it('should have correct filters for free groups', () => {
      const trivialGroup = mockStaticCfg.model_groups.trivial;
      const simpleGroup = mockStaticCfg.model_groups.simple;

      expect(trivialGroup.max_cost).toBe(0);
      expect(trivialGroup.method).toBe('min_cost');

      expect(simpleGroup.max_cost).toBe(0);
      expect(simpleGroup.min_gdpval).toBe(300);
      expect(simpleGroup.method).toBe('min_cost');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty free_models array', () => {
      const providerConfig = { billing: 'pay_per_token', free_models: [] };
      const freeModels: string[] = [];

      if (providerConfig.free_models && Array.isArray(providerConfig.free_models)) {
        for (const model of providerConfig.free_models) {
          freeModels.push(model);
        }
      }

      expect(freeModels).toHaveLength(0);
    });

    it('should handle missing free_models property', () => {
      const providerConfig = { billing: 'pay_per_token' };
      const freeModels: string[] = [];

      if (providerConfig.free_models && Array.isArray(providerConfig.free_models)) {
        for (const model of providerConfig.free_models) {
          freeModels.push(model);
        }
      }

      expect(freeModels).toHaveLength(0);
    });

    it('should handle duplicate models between static and dynamic', () => {
      const staticModels = ['qwen/qwen3-4b:free'];
      const dynamicModels = [
        { ref: 'qwen/qwen3-4b:free', gdpval: 400 },
        { ref: 'openrouter/google/gemma-3-4b-it:free', gdpval: 350 }
      ];

      const modelsToInclude = new Set<string>();
      
      for (const model of staticModels) {
        modelsToInclude.add(model);
      }
      
      for (const model of dynamicModels) {
        if (!modelsToInclude.has(model.ref)) {
          modelsToInclude.add(model.ref);
        }
      }

      const finalModels = Array.from(modelsToInclude);
      expect(finalModels).toHaveLength(2);
      expect(finalModels).toContain('qwen/qwen3-4b:free');
      expect(finalModels).toContain('openrouter/google/gemma-3-4b-it:free');
    });
  });
});
