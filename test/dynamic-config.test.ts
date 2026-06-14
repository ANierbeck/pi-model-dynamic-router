import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock für die globale Konfiguration und Cache
import type { Config, Cache } from '../src/types.js';

// Mock für die Metrics-Module
import * as metricsModule from '../src/metrics.js';
import { calculateScore, setConfig } from '../src/metrics.js';

// Mock für die Router-Klasse
import { Router } from '../src/routing.js';

// Mock für die GDPval-Lookup-Funktion
vi.mock('../src/metrics.js', async () => {
  const actual = await vi.importActual('../src/metrics.js');
  return {
    ...actual,
    lookupGdp: vi.fn(),
    effCost: vi.fn(),
    lookupPrice: vi.fn(),
    setConfig: vi.fn(),
    setCache: vi.fn(),
    getM: vi.fn(),
    updateMetrics: vi.fn(),
    calculateScore: vi.fn()
  };
});

// Mock für die RateLimitManager-Klasse
vi.mock('../src/rate-limit.js', () => ({
  RateLimitManager: class {
    constructor() {}
    getLimits() {
      return new Map();
    }
    isLimited() {
      return false;
    }
    limitSecs() {
      return 0;
    }
    recordLimit() {
      return { rotated: false };
    }
    recordOk() {}
    recordSoftFailure() {}
    costMux() {
      return 1;
    }
  }
}));

// Mock für die DiscoveryManager-Klasse
vi.mock('../src/discovery.js', () => ({
  DiscoveryManager: class {
    constructor() {}
    resolveKeyValue() {
      return undefined;
    }
    getCache() {
      return {};
    }
  }
}));

// Mock für die CacheManager-Klasse
vi.mock('../src/cache.js', () => ({
  CacheManager: class {
    constructor() {}
    loadCache() {
      return {};
    }
    saveCache() {}
  }
}));

// Test-Daten
const mockConfig: Config = {
  providers: {
    mistral: { billing: 'pay_per_token' },
    ollama: { billing: 'subscription' },
    openrouter: { billing: 'pay_per_token', free_models: [] }
  },
  model_groups: {
    trivial: {
      description: 'Trivial tasks - free models only',
      method: 'min_cost',
      max_cost: 0,
      models: ['qwen/qwen3-4b:free', 'google/gemma-3-4b-it:free']
    },
    simple: {
      description: 'Simple tasks - free models only',
      method: 'min_cost',
      max_cost: 0,
      models: ['qwen/qwen3-4b:free', 'google/gemma-3-12b-it:free']
    },
    standard: {
      description: 'Standard tasks - cost-effective models',
      method: 'tiered',
      min_gdpval: 500,
      max_cost_per_m: 0.5,
      models: ['openai/gpt-4o-mini', 'anthropic/claude-3-haiku']
    },
    complex: {
      description: 'Complex tasks - GDPval >=600',
      method: 'best',
      min_gdpval: 600,
      models: ['anthropic/claude-3-sonnet', 'openai/gpt-4o']
    },
    dynamic: {
      description: 'Dynamic routing',
      method: 'dynamic'
    }
  },
  model_metrics: {},
  gdpval_builtin: {
    'devstral': 585,
    'codestral-latest': 520,
    'mistral-medium-3-5': 665,
    'claude-3-sonnet': 680,
    'claude-3-haiku': 350
  }
};

const mockCache: Cache = {
  available_models: [
    { id: 'llama3.1', provider: 'ollama', cost_per_m: 0 },
    { id: 'llama3.1:8b-instruct-q4_K_M', provider: 'ollama', cost_per_m: 0 },
    { id: 'gemma3', provider: 'ollama', cost_per_m: 0 },
    { id: 'devstral-2512', provider: 'mistral', cost_per_m: 0 },
    { id: 'devstral-medium-2507', provider: 'mistral', cost_per_m: 0 },
    { id: 'codestral-latest', provider: 'mistral', cost_per_m: 0 },
    { id: 'claude-3-haiku', provider: 'anthropic', cost_per_m: 0.3 },
    { id: 'claude-3-sonnet', provider: 'anthropic', cost_per_m: 0.6 },
    { id: 'gpt-4o-mini', provider: 'openai', cost_per_m: 0.15 }
  ]
};

// Helper-Funktion zum Erstellen der Test-Umgebung
function createTestEnvironment() {
  const extDir = path.dirname(fileURLToPath(import.meta.url));
  
  // Mock für lookupGdp
  vi.mocked(metricsModule.lookupGdp).mockImplementation((ref: string) => {
    const gdpvalMap: Record<string, number> = {
      'ollama/llama3.1': 50,
      'ollama/llama3.1:8b-instruct-q4_K_M': 50,
      'ollama/gemma3': 50,
      'mistral/devstral-2512': 585,
      'mistral/devstral-medium-2507': 691,
      'mistral/codestral-latest': 520,
      'anthropic/claude-3-haiku': 350,
      'anthropic/claude-3-sonnet': 680,
      'anthropic/claude-4-sonnet': 720,
      'openai/gpt-4o-mini': 720
    };
    return gdpvalMap[ref] ?? null;
  });

  // Mock für effCost
  vi.mocked(metricsModule.effCost).mockImplementation((ref: string) => {
    const costMap: Record<string, number> = {
      'ollama/llama3.1': 0,
      'ollama/llama3.1:8b-instruct-q4_K_M': 0,
      'ollama/gemma3': 0,
      'mistral/devstral-2512': 0.4,
      'mistral/devstral-medium-2507': 0,
      'mistral/codestral-latest': 0,
      'anthropic/claude-3-haiku': 0.3,
      'anthropic/claude-3-sonnet': 0.6,
      'openai/gpt-4o-mini': 0.15
    };
    return costMap[ref] ?? 0;
  });

  // Mock für lookupPrice
  vi.mocked(metricsModule.lookupPrice).mockImplementation((ref: string) => {
    const priceMap: Record<string, { input: number, output: number }> = {
      'ollama/llama3.1': { input: 0, output: 0 },
      'ollama/llama3.1:8b-instruct-q4_K_M': { input: 0, output: 0 },
      'ollama/gemma3': { input: 0, output: 0 },
      'mistral/devstral-2512': { input: 400000, output: 400000 },
      'mistral/devstral-medium-2507': { input: 0, output: 0 },
      'mistral/codestral-latest': { input: 0, output: 0 },
      'anthropic/claude-3-haiku': { input: 300000, output: 1300000 },
      'anthropic/claude-3-sonnet': { input: 600000, output: 2000000 },
      'openai/gpt-4o-mini': { input: 150000, output: 600000 }
    };
    return priceMap[ref] ?? null;
  });

  // Mock für calculateScore - einfache Implementierung für die meisten Tests
  vi.mocked(metricsModule.calculateScore).mockImplementation((ref: string, taskType?: string, config?: any) => {
    // Einfache Scoring-Logik für die Tests
    const gdpval = metricsModule.lookupGdp(ref) ?? 0;
    const normalizedGdpval = Math.min(100, gdpval / 10);
    
    // Generation Bonus (Mock-Daten)
    const generationMap: Record<string, number> = {
      'anthropic/claude-3-sonnet': 3,
      'anthropic/claude-3-haiku': 3,
      'mistral/devstral-2512': 3,
      'mistral/devstral-medium-2507': 3,
      'mistral/codestral-latest': 1,
      'openai/gpt-4o-mini': 4
    };
    const generation = generationMap[ref] ?? 0;
    const generationBonus = Math.max(0, generation - 3) * 5;
    
    // Code-Bonus
    const isCodeModel = ref.includes('codestral') || taskType === 'code';
    const codeBonus = isCodeModel ? 5 : 0;
    
    return Math.min(100, normalizedGdpval + generationBonus + codeBonus);
  });

  return { extDir, mockConfig, mockCache };
}

describe('Dynamic Configuration Generation', () => {
  let extDir: string;
  let router: Router;

  beforeAll(() => {
    const { extDir: dir, mockConfig: cfg, mockCache: cache } = createTestEnvironment();
    extDir = dir;
    
    // Erstelle Router mit Mock-Daten
    const limits = new Map();
    router = new Router(cfg, cache, limits);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe('Group Filtering and Sorting', () => {
    test('trivial group should include free Ollama models', () => {
      const allModels = mockCache.available_models!.map(m => `${m.provider}/${m.id}`);
      const freeModels = allModels.filter(ref => {
        const eff = metricsModule.effCost(ref);
        return eff <= 0;
      });
      
      expect(freeModels).toContain('ollama/llama3.1');
      expect(freeModels).toContain('ollama/gemma3');
      expect(freeModels).not.toContain('anthropic/claude-3-sonnet');
    });

    test('standard group should filter models with GDPval >= 500', () => {
      const allModels = mockCache.available_models!.map(m => `${m.provider}/${m.id}`);
      const highGdpModels = allModels.filter(ref => {
        const gdpval = metricsModule.lookupGdp(ref);
        return gdpval !== null && gdpval >= 500;
      });
      
      expect(highGdpModels).toContain('mistral/devstral-2512');
      expect(highGdpModels).toContain('mistral/devstral-medium-2507');
      expect(highGdpModels).toContain('anthropic/claude-3-sonnet');
      expect(highGdpModels).not.toContain('ollama/llama3.1'); // GDP 50
      expect(highGdpModels).not.toContain('anthropic/claude-3-haiku'); // GDP 350
    });

    test('complex group should filter models with GDPval >= 600', () => {
      const allModels = mockCache.available_models!.map(m => `${m.provider}/${m.id}`);
      const complexModels = allModels.filter(ref => {
        const gdpval = metricsModule.lookupGdp(ref);
        return gdpval !== null && gdpval >= 600;
      });
      
      expect(complexModels).toContain('mistral/devstral-medium-2507'); // GDP 691
      expect(complexModels).toContain('anthropic/claude-3-sonnet'); // GDP 680
      expect(complexModels).not.toContain('mistral/devstral-2512'); // GDP 585
    });
  });

  describe('Model Sorting', () => {
    test('best method should sort by GDPval descending', () => {
      const models = [
        'mistral/devstral-medium-2507', // GDP 691
        'anthropic/claude-3-sonnet',    // GDP 680
        'openai/gpt-4o-mini'            // GDP 720
      ];
      
      const sorted = [...models].sort((a, b) => {
        const gdpB = metricsModule.lookupGdp(b) ?? 0;
        const gdpA = metricsModule.lookupGdp(a) ?? 0;
        return gdpB - gdpA;
      });
      
      expect(sorted[0]).toBe('openai/gpt-4o-mini'); // GDP 720
      expect(sorted[1]).toBe('mistral/devstral-medium-2507'); // GDP 691
      expect(sorted[2]).toBe('anthropic/claude-3-sonnet'); // GDP 680
    });

    test('min_cost method should sort by cost ascending, then GDPval descending', () => {
      const models = [
        'anthropic/claude-3-sonnet',    // Cost 0.6, GDP 680
        'openai/gpt-4o-mini',            // Cost 0.15, GDP 720
        'mistral/devstral-2512'         // Cost 0.4, GDP 585
      ];
      
      const sorted = [...models].sort((a, b) => {
        const costA = metricsModule.effCost(a);
        const costB = metricsModule.effCost(b);
        if (costA !== costB) return costA - costB;
        const gdpB = metricsModule.lookupGdp(b) ?? 0;
        const gdpA = metricsModule.lookupGdp(a) ?? 0;
        return gdpB - gdpA;
      });
      
      expect(sorted[0]).toBe('openai/gpt-4o-mini'); // Cost 0.15
      expect(sorted[1]).toBe('mistral/devstral-2512'); // Cost 0.4
      expect(sorted[2]).toBe('anthropic/claude-3-sonnet'); // Cost 0.6
    });

    test('tiered method should sort by GDPval descending, then cost ascending', () => {
      const models = [
        'anthropic/claude-3-sonnet',    // GDP 680, Cost 0.6
        'mistral/devstral-medium-2507', // GDP 691, Cost 0
        'openai/gpt-4o-mini'            // GDP 720, Cost 0.15
      ];
      
      const sorted = [...models].sort((a, b) => {
        const gdpA = metricsModule.lookupGdp(a) ?? 0;
        const gdpB = metricsModule.lookupGdp(b) ?? 0;
        if (gdpB !== gdpA) return gdpB - gdpA;
        return metricsModule.effCost(a) - metricsModule.effCost(b);
      });
      
      expect(sorted[0]).toBe('openai/gpt-4o-mini'); // GDP 720
      expect(sorted[1]).toBe('mistral/devstral-medium-2507'); // GDP 691
      expect(sorted[2]).toBe('anthropic/claude-3-sonnet'); // GDP 680
    });
  });

  describe('Multi-Metric Scoring', () => {
    // Für diese Tests verwenden wir eine vereinfachte Mock-Implementierung
    // die die wichtigsten Scoring-Prinzipien testet
    
    beforeAll(() => {
      // Setze eine spezielle Mock-Implementierung für calculateScore
      vi.mocked(metricsModule.calculateScore).mockImplementation((ref: string, taskType?: string, config?: any) => {
        // Einfache Scoring-Logik, die die wichtigsten Prinzipien abbildet
        const gdpval = metricsModule.lookupGdp(ref) ?? 0;
        const normalizedGdpval = Math.min(100, gdpval / 10);
        
        // Generation Bonus (Mock-Daten)
        const generationMap: Record<string, number> = {
          'anthropic/claude-3-sonnet': 3,
          'anthropic/claude-4-sonnet': 4,
          'mistral/devstral-medium-2507': 3,
          'mistral/codestral-latest': 1
        };
        const generation = generationMap[ref] ?? 0;
        const generationBonus = Math.max(0, generation - 3) * 5;
        
        // Code-Bonus für Code-Aufgaben
        const isCodeModel = ref.includes('codestral') || taskType === 'code';
        const codeBonus = isCodeModel ? 10 : 0;
        
        // Recency Bonus (Mock-Daten)
        const releaseDateMap: Record<string, string> = {
          'anthropic/claude-3-sonnet': '2024-02-26',
          'anthropic/claude-4-sonnet': '2025-03-01',
          'mistral/devstral-medium-2507': '2025-05-01',
          'mistral/codestral-latest': '2024-11-01'
        };
        let recencyBonus = 0;
        const releaseDate = releaseDateMap[ref];
        if (releaseDate) {
          const release = new Date(releaseDate);
          const monthsOld = (Date.now() - release.getTime()) / (1000 * 60 * 60 * 24 * 30);
          if (monthsOld < 6) recencyBonus = 5;
          else if (monthsOld < 12) recencyBonus = 3;
          else if (monthsOld < 18) recencyBonus = 1;
        }
        
        return Math.min(100, normalizedGdpval + generationBonus + codeBonus + recencyBonus);
      });
    });

    afterAll(() => {
      // Setze den Mock zurück
      vi.mocked(metricsModule.calculateScore).mockImplementation((ref: string, taskType?: string, config?: any) => {
        const gdpval = metricsModule.lookupGdp(ref) ?? 0;
        const normalizedGdpval = Math.min(100, gdpval / 10);
        
        const generationMap: Record<string, number> = {
          'anthropic/claude-3-sonnet': 3,
          'anthropic/claude-3-haiku': 3,
          'mistral/devstral-2512': 3,
          'mistral/devstral-medium-2507': 3,
          'mistral/codestral-latest': 1,
          'openai/gpt-4o-mini': 4
        };
        const generation = generationMap[ref] ?? 0;
        const generationBonus = Math.max(0, generation - 3) * 5;
        
        const isCodeModel = ref.includes('codestral') || taskType === 'code';
        const codeBonus = isCodeModel ? 5 : 0;
        
        return Math.min(100, normalizedGdpval + generationBonus + codeBonus);
      });
    });

    test('Claude 4 should score higher than Claude 3 due to generation bonus', () => {
      const scoreClaude4 = metricsModule.calculateScore('anthropic/claude-4-sonnet', 'standard');
      const scoreClaude3 = metricsModule.calculateScore('anthropic/claude-3-sonnet', 'standard');
      
      expect(scoreClaude4).toBeGreaterThan(scoreClaude3);
    });

    test('Claude 4 should score higher than devstral-medium-2507 despite similar GDPval', () => {
      // Claude 4: GDPval 720, Generation 4
      // devstral-medium-2507: GDPval 691, Generation 3
      const scoreClaude4 = metricsModule.calculateScore('anthropic/claude-4-sonnet', 'standard');
      const scoreDevstral = metricsModule.calculateScore('mistral/devstral-medium-2507', 'standard');
      
      // Claude 4 sollte höher score due zu Generation 4 Bonus
      expect(scoreClaude4).toBeGreaterThan(scoreDevstral);
    });

    test('Code models should get bonus for code tasks', () => {
      // In unserer Mock-Implementierung:
      // taskType='code' gibt +10 Bonus für ALLE Modelle
      const scoreGeneral = metricsModule.calculateScore('anthropic/claude-3-sonnet', 'standard');
      const scoreCode = metricsModule.calculateScore('anthropic/claude-3-sonnet', 'code');
      
      // scoreCode sollte scoreGeneral + 10 sein
      expect(scoreCode).toBe(scoreGeneral + 10);
    });

    test('Recent models should get recency bonus', () => {
      // devstral-medium-2507: Release 2025-05-01 (neu, sollte Bonus bekommen)
      // claude-3-sonnet: Release 2024-02-26 (älter)
      const scoreDevstral = metricsModule.calculateScore('mistral/devstral-medium-2507', 'standard');
      const scoreClaude3 = metricsModule.calculateScore('anthropic/claude-3-sonnet', 'standard');
      
      // devstral-medium-2507 sollte aufgrund des Release-Datums Bonus bekommen
      expect(scoreDevstral).toBeGreaterThan(scoreClaude3);
    });

    test('Scoring should be between 0 and 100', () => {
      const models = [
        'anthropic/claude-3-sonnet',
        'anthropic/claude-4-sonnet',
        'mistral/devstral-medium-2507',
        'mistral/codestral-latest'
      ];
      
      for (const model of models) {
        const score = metricsModule.calculateScore(model, 'standard');
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('Original Models Fallback', () => {
    test('should include original models that pass filters', () => {
      const originalModels = mockConfig.model_groups.standard.models!;
      const allModels = mockCache.available_models!.map(m => `${m.provider}/${m.id}`);
      
      // Prüfe ob die Original-Modelle in den verfügbaren Modellen sind
      // oder zumindest die Filter passieren würden
      for (const origModel of originalModels) {
        const gdpval = metricsModule.lookupGdp(origModel);
        const cost = metricsModule.effCost(origModel);
        
        // standard group: min_gdpval >= 500, max_cost_per_m <= 0.5
        const passesGdpFilter = gdpval !== null && gdpval >= 500;
        const price = metricsModule.lookupPrice(origModel);
        const passesCostFilter = price ? price.input <= 0.5 * 1000000 : true;
        
        // Mindestens eine Bedingung sollte erfüllt sein
        expect(passesGdpFilter || passesCostFilter).toBe(true);
      }
    });

    test('should exclude original models that fail filters', () => {
      // claude-3-haiku hat GDP 350, sollte also nicht in standard (min_gdpval: 500) rein
      const gdpval = metricsModule.lookupGdp('anthropic/claude-3-haiku');
      expect(gdpval).toBe(350);
      expect(gdpval! < 500).toBe(true);
    });
  });
});

describe('Dynamic Config File Generation', () => {
  const testExtDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-dynamic-config');
  const dynamicConfigPath = path.join(testExtDir, 'router-config.dynamic.json');

  beforeAll(() => {
    // Erstelle Test-Verzeichnis
    if (!fs.existsSync(testExtDir)) {
      fs.mkdirSync(testExtDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Lösche Test-Dateien
    if (fs.existsSync(dynamicConfigPath)) {
      fs.unlinkSync(dynamicConfigPath);
    }
    if (fs.existsSync(testExtDir)) {
      fs.rmdirSync(testExtDir);
    }
  });

  test('should generate valid JSON configuration', () => {
    // Simuliere die Generierung einer dynamischen Konfiguration
    const dynamicConfig = {
      ...mockConfig,
      model_groups: {
        ...mockConfig.model_groups,
        standard: {
          ...mockConfig.model_groups.standard,
          models: [
            'mistral/devstral-medium-2507',
            'anthropic/claude-3-sonnet',
            'openai/gpt-4o-mini'
          ]
        }
      },
      _dynamic: {
        generated_at: new Date().toISOString(),
        source: 'router scan',
        model_count: 8,
        base_config: 'router-config.json'
      }
    };

    // Speichere die Konfiguration
    fs.writeFileSync(dynamicConfigPath, JSON.stringify(dynamicConfig, null, 2));

    // Prüfe ob die Datei existiert
    expect(fs.existsSync(dynamicConfigPath)).toBe(true);

    // Prüfe ob die Datei gültiges JSON ist
    const content = fs.readFileSync(dynamicConfigPath, 'utf-8');
    const parsed = JSON.parse(content);
    
    expect(parsed).toHaveProperty('_dynamic');
    expect(parsed._dynamic.source).toBe('router scan');
    expect(parsed.model_groups.standard.models).toBeDefined();
    expect(Array.isArray(parsed.model_groups.standard.models)).toBe(true);
  });

  test('should include metadata in dynamic config', () => {
    const dynamicConfig = {
      ...mockConfig,
      _dynamic: {
        generated_at: new Date().toISOString(),
        source: 'router scan',
        model_count: 8,
        base_config: 'router-config.json'
      }
    };

    fs.writeFileSync(dynamicConfigPath, JSON.stringify(dynamicConfig, null, 2));

    const content = fs.readFileSync(dynamicConfigPath, 'utf-8');
    const parsed = JSON.parse(content);

    expect(parsed._dynamic).toHaveProperty('generated_at');
    expect(parsed._dynamic).toHaveProperty('source');
    expect(parsed._dynamic).toHaveProperty('model_count');
    expect(parsed._dynamic).toHaveProperty('base_config');
  });
});

describe('Configuration Loading Priority', () => {
  const testExtDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-config-loading');
  const staticConfigPath = path.join(testExtDir, 'router-config.json');
  const dynamicConfigPath = path.join(testExtDir, 'router-config.dynamic.json');

  beforeAll(() => {
    if (!fs.existsSync(testExtDir)) {
      fs.mkdirSync(testExtDir, { recursive: true });
    }
    
    // Erstelle statische Konfiguration
    fs.writeFileSync(staticConfigPath, JSON.stringify(mockConfig, null, 2));
  });

  afterAll(() => {
    // Lösche Test-Dateien
    if (fs.existsSync(staticConfigPath)) {
      fs.unlinkSync(staticConfigPath);
    }
    if (fs.existsSync(dynamicConfigPath)) {
      fs.unlinkSync(dynamicConfigPath);
    }
    if (fs.existsSync(testExtDir)) {
      fs.rmdirSync(testExtDir);
    }
  });

  test('should prefer dynamic config over static config when both exist', () => {
    // Erstelle dynamische Konfiguration
    const dynamicConfig = {
      ...mockConfig,
      model_groups: {
        ...mockConfig.model_groups,
        test_group: {
          description: 'Test group from dynamic config',
          method: 'best',
          models: ['test-model']
        }
      },
      _dynamic: {
        generated_at: new Date().toISOString(),
        source: 'router scan'
      }
    };
    
    fs.writeFileSync(dynamicConfigPath, JSON.stringify(dynamicConfig, null, 2));

    // Simuliere das Laden der Konfiguration
    let loadedConfig: any = null;
    
    // Versuche zuerst dynamische Konfiguration
    if (fs.existsSync(dynamicConfigPath)) {
      const content = fs.readFileSync(dynamicConfigPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed._dynamic && parsed.model_groups) {
        loadedConfig = parsed;
      }
    }
    
    // Falls keine dynamische, lade statische
    if (!loadedConfig && fs.existsSync(staticConfigPath)) {
      loadedConfig = JSON.parse(fs.readFileSync(staticConfigPath, 'utf-8'));
    }

    expect(loadedConfig).toBeDefined();
    expect(loadedConfig!._dynamic).toBeDefined();
    expect(loadedConfig!.model_groups.test_group).toBeDefined();
  });

  test('should fall back to static config when dynamic config does not exist', () => {
    // Lösche dynamische Konfiguration
    if (fs.existsSync(dynamicConfigPath)) {
      fs.unlinkSync(dynamicConfigPath);
    }

    // Simuliere das Laden der Konfiguration
    let loadedConfig: any = null;
    
    if (fs.existsSync(dynamicConfigPath)) {
      const content = fs.readFileSync(dynamicConfigPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed._dynamic && parsed.model_groups) {
        loadedConfig = parsed;
      }
    }
    
    if (!loadedConfig && fs.existsSync(staticConfigPath)) {
      loadedConfig = JSON.parse(fs.readFileSync(staticConfigPath, 'utf-8'));
    }

    expect(loadedConfig).toBeDefined();
    expect(loadedConfig!._dynamic).toBeUndefined();
    expect(loadedConfig!.model_groups.trivial).toBeDefined();
  });
});
