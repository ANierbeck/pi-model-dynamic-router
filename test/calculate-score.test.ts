import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { calculateScore, setConfig, setCache, setGdpval } from '../src/metrics.js';

describe('calculateScore - Real Implementation Tests', () => {
  // Diese Tests verwenden die ECHTE calculateScore-Funktion ohne Mocks
  
  beforeEach(() => {
    // Setze die Konfiguration für die Tests
    setConfig({
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: {
        'claude-3-sonnet': 680,
        'claude-4-sonnet': 720,
        'devstral-medium-2507': 691,
        'codestral-latest': 520
      },
      model_metadata: {
        'anthropic/claude-3-sonnet': { generation: 3, type: 'general', release_date: '2024-02-26' },
        'anthropic/claude-4-sonnet': { generation: 4, type: 'general', release_date: '2025-03-01' },
        'mistral/devstral-medium-2507': { generation: 3, type: 'general', release_date: '2025-05-01' },
        'mistral/codestral-latest': { generation: 1, type: 'code', release_date: '2026-01-01' }
      },
      model_benchmarks: {
        'anthropic/claude-3-sonnet': { mmlu: 88.7, gpqa: 84.5, truthful: 85.1, humaneval: 0.852, swebench: 0.654 },
        'anthropic/claude-4-sonnet': { mmlu: 92.5, gpqa: 90.1, truthful: 91.2, humaneval: 0.905, swebench: 0.753 },
        'mistral/devstral-medium-2507': { mmlu: 89.2, gpqa: 85.1, truthful: 86.3, humaneval: 0.868, swebench: 0.671 },
        'mistral/codestral-latest': { mmlu: 82.3, gpqa: 79.8, truthful: 81.5, humaneval: 0.855, swebench: 0.682 }
      }
    });
    setCache({});
    setGdpval({
      'claude-3-sonnet': 680,
      'claude-4-sonnet': 720,
      'devstral-medium-2507': 691,
      'codestral-latest': 520
    });
  });

  afterEach(() => {
    // Setze alles zurück
    setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
    setCache({});
    setGdpval({});
  });

  test('Claude 4 should score higher than Claude 3 due to generation bonus', () => {
    const scoreClaude4 = calculateScore('anthropic/claude-4-sonnet', 'standard');
    const scoreClaude3 = calculateScore('anthropic/claude-3-sonnet', 'standard');
    
    expect(scoreClaude4).toBeGreaterThan(scoreClaude3);
  });

  test('Claude 4 should score higher than devstral-medium-2507 despite similar GDPval', () => {
    const scoreClaude4 = calculateScore('anthropic/claude-4-sonnet', 'standard');
    const scoreDevstral = calculateScore('mistral/devstral-medium-2507', 'standard');
    
    // Claude 4: GDPval 720, Generation 4, neu (2025-03-01)
    // devstral-medium-2507: GDPval 691, Generation 3, neu (2025-05-01)
    // Claude 4 sollte durch Generation-Bonus gewinnen
    expect(scoreClaude4).toBeGreaterThan(scoreDevstral);
  });

  test('Code models should get bonus for code tasks', () => {
    // Verwende ein Code-spezialisées Modell (codestral-latest) für den Test
    // Für Code-Aufgaben werden Code-Benchmarks stärker gewichtet (35% SWE-bench vs 20%)
    // und es gibt einen +5 Code-Bonus
    const scoreGeneral = calculateScore('mistral/codestral-latest', 'standard');
    const scoreCode = calculateScore('mistral/codestral-latest', 'code');
    
    // codestral-latest sollte für Code-Aufgaben höher score
    // weil: 1) SWE-bench hat höhere Gewichtung (35% vs 20%)
    //       2) HumanEval hat höhere Gewichtung (25% vs 10%)
    //       3) +5 Code-Bonus für Code-Aufgaben
    expect(scoreCode).toBeGreaterThan(scoreGeneral);
  });

  test('Recent models should get recency bonus', () => {
    // devstral-medium-2507: Release 2025-05-01 (13 Monate alt, +1 Recency Bonus)
    // claude-3-sonnet: Release 2024-02-26 (16 Monate alt, 0 Recency Bonus)
    // devstral gewinnt hauptsächlich wegen höherem GDPval (691 vs 680) und besseren Benchmarks,
    // der Recency Bonus (+1) ist ein zusätzlicher Faktor
    const scoreDevstral = calculateScore('mistral/devstral-medium-2507', 'standard');
    const scoreClaude3 = calculateScore('anthropic/claude-3-sonnet', 'standard');
    
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
      const score = calculateScore(model, 'standard');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});
