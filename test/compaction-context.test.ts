// test/compaction-context.test.ts
// Tests for the context-window guard: driveStream must skip models whose
// context window is too small for the current conversation, and the
// classifier must route compaction turns to strategic (not small local models).

import { describe, it, expect } from 'vitest';
import { classifyPrompt } from '../src/content-classifier.js';
import type { Config, Cache } from '../src/types.js';

// Minimal config with a dynamic group and classifier fallback
const cfg: Config = {
  model_groups: {
    dynamic: {
      method: 'dynamic',
      classifier_model: 'test-classifier',
      classifier_fallback: 'test-fallback',
      routes: {
        code_simple: 'simple',
        code_complex: 'complex',
        design: 'strategic',
        planning: 'tactical',
        exploration: 'scout',
        fallback: 'fallback',
      },
    },
  },
  model_metrics: {},
  gdpval_builtin: {},
} as any;

const cache: Cache = {
  available_models: [],
} as any;

describe('compaction context-window routing', () => {
  it('routes to strategic when last model was a small local model', async () => {
    const result = await classifyPrompt('Compact this conversation', {
      allowStaticFallback: true,
      allowCloudFallback: true,
      cfg,
      cache,
      context: {
        isCompaction: true,
        lastModel: 'ollama/gemma4:12b-mlx',
      },
    });

    // Should NOT return a model hint — should route to a category
    expect('hintType' in result).toBe(false);
    expect('category' in result).toBe(true);
    if ('category' in result) {
      expect(result.category).toBe('code_complex');
    }
  });

  it('reuses last model when it was a large cloud model', async () => {
    const result = await classifyPrompt('Compact this conversation', {
      allowStaticFallback: true,
      allowCloudFallback: true,
      cfg,
      cache,
      context: {
        isCompaction: true,
        lastModel: 'claude-bridge/claude-opus-5',
      },
    });

    // Should return a model hint to reuse the last model
    expect('hintType' in result).toBe(true);
    if ('hintType' in result) {
      expect(result.hintType).toBe('model');
      expect(result.hintTarget).toBe('claude-bridge/claude-opus-5');
    }
  });

  it('routes to strategic when no last model is known', async () => {
    const result = await classifyPrompt('Compact this conversation', {
      allowStaticFallback: true,
      allowCloudFallback: true,
      cfg,
      cache,
      context: {
        isCompaction: true,
        lastModel: undefined,
      },
    });

    expect('hintType' in result).toBe(false);
    if ('category' in result) {
      expect(result.category).toBe('code_complex');
    }
  });

  it('reuses last model when it was a medium cloud model (not small-local)', async () => {
    const result = await classifyPrompt('Compact this conversation', {
      allowStaticFallback: true,
      allowCloudFallback: true,
      cfg,
      cache,
      context: {
        isCompaction: true,
        lastModel: 'mistral/mistral-medium-2604',
      },
    });

    expect('hintType' in result).toBe(true);
    if ('hintType' in result) {
      expect(result.hintTarget).toBe('mistral/mistral-medium-2604');
    }
  });

  it('detects small local models by parameter count', async () => {
    // 3B model should route to strategic, not be reused
    const result3b = await classifyPrompt('Compact', {
      allowStaticFallback: true,
      allowCloudFallback: true,
      cfg,
      cache,
      context: { isCompaction: true, lastModel: 'ollama/llama3.1:8b' },
    });
    expect('hintType' in result3b).toBe(false);

    // 35B model — should still be detected as local-small if from ollama
    const result35b = await classifyPrompt('Compact', {
      allowStaticFallback: true,
      allowCloudFallback: true,
      cfg,
      cache,
      context: { isCompaction: true, lastModel: 'ollama/qwen3.6:35b-mlx' },
    });
    expect('hintType' in result35b).toBe(false);
  });
});