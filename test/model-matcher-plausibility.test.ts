// test/model-matcher-plausibility.test.ts
// Tests for the cross-family hallucination guard (isPlausibleMatch).
//
// The LLM (gemma2:2b) sometimes matches a model to a slug from a completely
// different family — e.g. "mistral/mistral-medium-2604" → "claude-opus-5".
// This is obviously wrong. isPlausibleMatch() rejects such cross-family
// matches so they don't pollute the router table with inflated scores.

import { describe, it, expect } from 'vitest';
import { isPlausibleMatch } from '../src/model-matcher.js';

describe('isPlausibleMatch — cross-family hallucination guard', () => {
  it('allows same-family matches (mistral → mistral)', () => {
    expect(isPlausibleMatch('mistral/mistral-medium-2604', 'mistral-medium-3-5')).toBe(true);
    expect(isPlausibleMatch('mistral/ministral-3b-latest', 'mistral-nemo')).toBe(true);
    expect(isPlausibleMatch('mistral/codestral-latest', 'codestral-latest')).toBe(true);
  });

  it('allows same-family matches (claude → claude)', () => {
    expect(isPlausibleMatch('claude-bridge/claude-opus-5', 'claude-opus-5')).toBe(true);
    expect(isPlausibleMatch('claude-bridge/claude-sonnet-5', 'claude-4-5-sonnet')).toBe(true);
    expect(isPlausibleMatch('claude-bridge/claude-haiku-4-5', 'claude-3-5-haiku')).toBe(true);
  });

  it('allows GLM family matches (glm/zai → glm)', () => {
    expect(isPlausibleMatch('mistral-zai/zai-glm-5-2', 'glm-5-2')).toBe(true);
    expect(isPlausibleMatch('mistral/glm-5-2', 'glm-5-2')).toBe(true);
    expect(isPlausibleMatch('chutes/zai-org/GLM-5-TEE', 'glm-5')).toBe(true);
  });

  it('REJECTS cross-family hallucinations (the actual bugs we saw)', () => {
    // These are the EXACT false matches from the live cache:
    expect(isPlausibleMatch('mistral/mistral-medium-2604', 'claude-opus-5')).toBe(false);
    expect(isPlausibleMatch('mistral-zai/mistral-medium-2604', 'qwen3')).toBe(false);
    expect(isPlausibleMatch('mistral-zai/mistral-large-latest', 'qwen3')).toBe(false);
    expect(isPlausibleMatch('mistral-zai/ministral-3b-latest', 'qwen3')).toBe(false);
    expect(isPlausibleMatch('claude-bridge/claude-sonnet-5', 'qwen38-max')).toBe(false);
    expect(isPlausibleMatch('mistral-zai/mistral-medium', 'qwen3')).toBe(false);
  });

  it('allows same-family matches even across size tiers (size-tier is a PROMPT rule, not a guard)', () => {
    // The size-tier rule is conveyed to the LLM via buildMatchPrompt(),
    // NOT enforced by isPlausibleMatch(). The guard only checks family.
    // So ministral-3b → mistral-medium-3-5 IS plausible (same family) —
    // the LLM is trusted to follow the size-tier rule in the prompt.
    expect(isPlausibleMatch('mistral/ministral-3b-latest', 'mistral-medium-3-5')).toBe(true);
    expect(isPlausibleMatch('mistral/ministral-8b-latest', 'mistral-medium-3-5')).toBe(true);
  });

  it('allows matches when neither has a known family (conservative allow)', () => {
    expect(isPlausibleMatch('unknown-model', 'unknown-slug')).toBe(true);
    expect(isPlausibleMatch('foo/bar', 'baz')).toBe(true);
  });

  it('rejects mistral → openai/gpt cross-family', () => {
    expect(isPlausibleMatch('mistral/mistral-large', 'gpt-5-5')).toBe(false);
  });

  it('rejects claude → gemma cross-family', () => {
    expect(isPlausibleMatch('claude-bridge/claude-opus-5', 'gemma4-12b')).toBe(false);
  });

  it('allows google family: gemma → gemma', () => {
    expect(isPlausibleMatch('ollama/gemma4:latest', 'gemma4-27b')).toBe(true);
    expect(isPlausibleMatch('ollama/gemma2:2b', 'gemma2-9b')).toBe(true);
  });

  it('allows llama family: llama → llama', () => {
    expect(isPlausibleMatch('ollama/llama3.1:latest', 'llama3-3-instruct-70b')).toBe(true);
  });

  it('allows deepseek family: deepseek → deepseek', () => {
    expect(isPlausibleMatch('openrouter/deepseek/deepseek-v3', 'deepseek-v4-pro')).toBe(true);
  });
});
