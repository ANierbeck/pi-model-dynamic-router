// test/classifier.test.ts
// Unit tests for content-sensitive classification (without Ollama)

import { describe, it, beforeEach, expect, vi } from 'vitest';
import { classifyPrompt, CATEGORY_TO_GROUP } from '../src/content-classifier.js';
import * as ollamaUtils from '../src/ollama-utils';
import { localModelCache } from './helpers/local-model-cache.ts';

// ── Mock for Ollama calls (for unit tests) ────────────────────────────────

vi.mock('../src/ollama-utils', () => ({
  callOllama: vi.fn(),
  // Daemon probed as reachable so the mocked Ollama path stays exercised.
  isOllamaAvailable: vi.fn(async () => true),
}));

// ── Test cases ───────────────────────────────────────────────────────────

describe('classifyPrompt (Unit Tests)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("classifies simple code changes as 'code_simple'", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "code_simple", "reason": "Simple text replacement", "confidence": 0.95}'
    );

    const result = await classifyPrompt("Replace 'foo' with 'bar' in line 42", {
      cache: localModelCache(),
    });
    expect(result.category).toBe('code_simple');
    expect(result.reason).toContain('Simple text replacement');
    expect(CATEGORY_TO_GROUP[result.category]).toBe('simple');
  });

  it("classifies complex code changes as 'code_complex'", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "code_complex", "reason": "Refactoring required", "confidence": 0.9}'
    );

    const result = await classifyPrompt('Optimize this 200-line function for performance', {
      cache: localModelCache(),
    });
    expect(result.category).toBe('code_complex');
    expect(CATEGORY_TO_GROUP[result.category]).toBe('code_complex');
  });

  it("classifies design questions as 'design'", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "design", "reason": "Architecture design", "confidence": 0.85}'
    );

    const result = await classifyPrompt('Design an event-sourcing architecture', {
      cache: localModelCache(),
    });
    expect(result.category).toBe('design');
    expect(CATEGORY_TO_GROUP[result.category]).toBe('design');
  });

  it("classifies unclear requests as 'continue'", async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "continue", "reason": "Unclear request", "confidence": 0.3}'
    );

    const result = await classifyPrompt('Make this better', { cache: localModelCache() });
    expect(result.category).toBe('continue');
    expect(CATEGORY_TO_GROUP[result.category]).toBe('standard'); // D6 default
  });

  it('handles Ollama errors with the continue fallback (no keyword classifier)', async () => {
    vi.mocked(ollamaUtils.callOllama).mockRejectedValue(new Error('Ollama not running'));

    const result = await classifyPrompt('Explain something', { cache: localModelCache() });
    expect(result.category).toBe('continue');
    expect(result.reason).toBe('no classifier answered');
  });

  it('validates the JSON format of the Ollama response', async () => {
    vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
      '{"category": "invalid_category", "reason": "test"}'
    );

    // Should fall back to fallback, since "invalid_category" is not allowed
    const result = await classifyPrompt('Test', { cache: localModelCache() });
    expect(result.category).toBe('continue');
  });

  it('inherits category for short prompts with context', async () => {
    const result = await classifyPrompt('Yes', {
      context: { lastCategory: 'code_complex' },
    });
    expect(result.category).toBe('code_complex');
    expect(result.reason).toContain('Short prompt');
  });
});
