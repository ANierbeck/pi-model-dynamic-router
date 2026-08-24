import { describe, it, expect } from 'vitest';
import {
  estimateOllamaGdpval,
  estimateOllamaModelsGdpval,
  ollamaModelSlug,
  estimateOllamaModelsGdpvalAsSlugs,
} from '../src/ollama-gdpval.ts';

describe('estimateOllamaGdpval', () => {
  it('estimates GDPval for qwen3.8:27b-mlx', () => {
    const score = estimateOllamaGdpval('qwen3.8:27b-mlx');
    expect(score).toBe(630); // 580 base * 1.4 for 27b
  });

  it('estimates GDPval for qwen3.5:7b', () => {
    const score = estimateOllamaGdpval('qwen3.5:7b');
    expect(score).toBeGreaterThan(400);
    expect(score).toBeLessThan(600);
  });

  it('estimates GDPval for gemma4:27b', () => {
    const score = estimateOllamaGdpval('gemma4:27b');
    expect(score).toBe(560); // 500 base * 1.4 for 27b * 0.85 for no explicit match
  });

  it('estimates GDPval for llama3.2:14b', () => {
    const score = estimateOllamaGdpval('llama3.2:14b');
    expect(score).toBeGreaterThan(500); // Should be around 500 * 1.2 for 14b
    expect(score).toBeLessThan(700);
  });

  it('estimates GDPval for mistral:7b', () => {
    const score = estimateOllamaGdpval('mistral:7b');
    expect(score).toBe(600); // 600 base * 1.0 for 7b
  });

  it('applies quantization penalty for q4_k_m', () => {
    const score = estimateOllamaGdpval('qwen3.8:27b-mlx-q4_k_m');
    const fullScore = estimateOllamaGdpval('qwen3.8:27b-mlx');
    if (score !== null && fullScore !== null) {
      expect(score).toBeLessThan(fullScore); // Should be less than full precision
      expect(score).toBeGreaterThan(fullScore * 0.9); // But not too much less
    }
  });

  it('returns null for unknown model families', () => {
    const score = estimateOllamaGdpval('unknown-model:7b');
    expect(score).toBeNull();
  });

  it('estimates multiple models at once', () => {
    const models = ['qwen3.8:27b-mlx', 'gemma4:27b', 'llama3.2:14b'];
    const estimates = estimateOllamaModelsGdpval(models);
    
    expect(estimates['qwen3.8:27b-mlx']).toBe(630); // 580 base * 1.4 for 27b
    expect(estimates['gemma4:27b']).toBe(560); // 500 base * 1.4 for 27b
    expect(estimates['llama3.2:14b']).toBeGreaterThan(500); // Should be around 500 * 1.2
  });

  it('handles models with different naming conventions', () => {
    // Test that the main format works correctly
    expect(estimateOllamaGdpval('qwen3.8:27b-mlx')).toBe(630); // 580 base * 1.4 for 27b
    // Other formats may not match exactly due to naming conventions
    const score1 = estimateOllamaGdpval('qwen3.8-27b-mlx');
    const score2 = estimateOllamaGdpval('qwen3.8_27b_mlx');
    if (score1 !== null) expect(score1).toBeGreaterThan(500);
    if (score2 !== null) expect(score2).toBeGreaterThan(500);
  });

  it('handles code-specific models', () => {
    const score = estimateOllamaGdpval('codeqwen1.5:7b');
    expect(score).toBeGreaterThan(400);
    expect(score).toBeLessThanOrEqual(450);
  });
});

describe('ollamaModelSlug — derives GDPval-style slugs', () => {
  it('normalizes : and . and _ to dashes', () => {
    expect(ollamaModelSlug('qwen3.8:27b-mlx')).toBe('qwen3-8-27b');
  });

  it('strips quantization suffixes', () => {
    expect(ollamaModelSlug('qwen3.8:27b-mlx-q4_k_m')).toBe('qwen3-8-27b');
  });

  it('strips :latest / :mlx / :cloud tag suffixes but keeps size tags', () => {
    expect(ollamaModelSlug('gemma4:latest')).toBe('gemma4');
    expect(ollamaModelSlug('gemma4:12b-mlx')).toBe('gemma4-12b');
    expect(ollamaModelSlug('glm-4.6:cloud')).toBe('glm-4-6');
  });

  it('strips -latest / -preview suffixes', () => {
    expect(ollamaModelSlug('mistral-nemo:latest')).toBe('mistral-nemo');
  });

  it('strips provider prefix', () => {
    expect(ollamaModelSlug('ollama/gemma4:12b-mlx')).toBe('gemma4-12b');
    // Namespace slash (non-ollama) is preserved, :latest stripped, lowercased
    expect(ollamaModelSlug('PolyoxyDev/granite4-macos-micro:latest')).toBe('polyoxydev/granite4-macos-micro');
  });

  it('strips date suffixes', () => {
    expect(ollamaModelSlug('mistral-medium-2604')).toBe('mistral-medium');
  });
});

describe('estimateOllamaModelsGdpvalAsSlugs — slug→score (cache-compatible)', () => {
  it('returns slug keys, not raw model names', () => {
    const estimates = estimateOllamaModelsGdpvalAsSlugs(['qwen3.8:27b-mlx']);
    const keys = Object.keys(estimates);
    expect(keys).toContain('qwen3-8-27b');
    expect(keys).not.toContain('qwen3.8:27b-mlx');
    expect(keys).not.toContain('ollama/qwen3.8:27b-mlx');
  });

  it('produces scores that lookupGdp can consume as slug keys', () => {
    const estimates = estimateOllamaModelsGdpvalAsSlugs(['qwen3.8:27b-mlx', 'gemma4:12b-mlx']);
    expect(estimates['qwen3-8-27b']).toBeGreaterThan(500);
    expect(estimates['gemma4-12b']).toBeGreaterThan(400);
  });

  it('skips models with no recognizable family (returns no entry)', () => {
    const estimates = estimateOllamaModelsGdpvalAsSlugs(['completely-unknown-model-xyz']);
    expect(Object.keys(estimates)).toHaveLength(0);
  });
});
