// Regression tests for the Ollama availability guard in the escalation
// LLM loop detection (2026-09-26, live offline test finding).
//
// BUG: detectLoopWithLLM called callOllama directly. With the daemon
// stopped (Achim's offline test), every periodic check failed with
// "TypeError: fetch failed" and spammed the router log 5×.
//
// FIX: guard with isOllamaAvailable (the same 1.5s-cap / 15s-negative-
// cache probe the classifier uses) — daemon down → skip the LLM call and
// fall back to the rule-based path, without fetch noise.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/ollama-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ollama-utils.ts')>();
  return { ...actual, callOllama: vi.fn(), isOllamaAvailable: vi.fn() };
});

import { callOllama, isOllamaAvailable } from '../src/ollama-utils.ts';
import { detectLoopWithLLM } from '../src/escalation.ts';

const history = [
  { prompt: 'Please check the config file', response: 'The config contains X' },
  { prompt: 'Please check the config file', response: 'The config contains X' },
];

describe('detectLoopWithLLM — Ollama availability guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips the LLM call when the daemon is unreachable', async () => {
    vi.mocked(isOllamaAvailable).mockResolvedValue(false);

    const result = await detectLoopWithLLM(history, { model: 'ollama/gemma2:2b' });

    expect(callOllama).not.toHaveBeenCalled();
    expect(result.shouldEscalate).toBe(false);
    expect(result.reason).toMatch(/unavailable/i);
  });

  it('still calls the LLM when the daemon is reachable', async () => {
    vi.mocked(isOllamaAvailable).mockResolvedValue(true);
    vi.mocked(callOllama).mockResolvedValue('{"shouldEscalate": false, "reason": "No loop detected"}');

    const result = await detectLoopWithLLM(history, { model: 'ollama/gemma2:2b' });

    expect(callOllama).toHaveBeenCalledTimes(1);
    expect(result.shouldEscalate).toBe(false);
    expect(result.reason).toBe('No loop detected');
  });

  it('escalates on a genuine LLM loop verdict when the daemon is up', async () => {
    vi.mocked(isOllamaAvailable).mockResolvedValue(true);
    vi.mocked(callOllama).mockResolvedValue('{"shouldEscalate": true, "reason": "same prompt twice"}');

    const result = await detectLoopWithLLM(history, { model: 'ollama/gemma2:2b' });

    expect(result.shouldEscalate).toBe(true);
  });
});
