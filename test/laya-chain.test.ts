// test/laya-chain.test.ts
//
// Red-first tests for Task 4: Laya stage in the classifyPrompt chain.
// Chain order: HINT (deterministic) → Laya (local, confidence-gated) →
// cloud/ollama leg → static keyword fallback.
//
// IMPORTANT: every test uses a UNIQUE prompt. classifyPrompt caches LLM
// results per prompt string (module-level, 5-minute TTL); identical prompts
// across tests would hit that cache and skip the code under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyPrompt } from '../src/content-classifier.ts';
import { callOllama, isOllamaAvailable } from '../src/ollama-utils.ts';
import {
  classifyWithLaya,
  classifyWithLayaRaw,
  isLayaAvailable,
  probeLaya,
  resetLayaAvailability,
} from '../src/laya-classifier.ts';
import type { Config } from '../src/types.ts';
import { localModelCache } from './helpers/local-model-cache.ts';

// classifyWithLaya holds an internal binding to classifyWithLayaRaw, so mocking
// only the raw export does not affect the client path. We therefore mock
// classifyWithLaya with a hand-built implementation that reproduces the real
// gating logic (enabled, availability, threshold) and calls the mocked raw
// function — the raw function itself is exercised and verified in
// test/laya-classifier.test.ts.
vi.mock('../src/laya-classifier.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/laya-classifier.ts')>();
  return {
    ...actual,
    classifyWithLayaRaw: vi.fn(),
    classifyWithLaya: vi.fn(),
    isLayaAvailable: vi.fn(),
    probeLaya: vi.fn(),
  };
});

vi.mock('../src/ollama-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ollama-utils.ts')>();
  return { ...actual, callOllama: vi.fn(), isOllamaAvailable: vi.fn() };
});

type Lay = Config['classifier_laya'];

const layaAnswer = {
  category: 'standard',
  confidence: 0.95,
  probabilities: { standard: 0.95, code_simple: 0.03, trivial: 0.02 },
  ms: 5,
};

const layaConfig: Lay = {
  enabled: true,
  checkpoint: 'test-checkpoint-rev-abc123',
  endpoint: 'http://127.0.0.1:8089',
  timeout_ms: 1500,
  confidence_threshold: 0.8,
};

const layaCfg = (overrides?: Partial<Lay>): Lay => ({ ...layaConfig, ...overrides });

vi.mocked(classifyWithLaya).mockImplementation(async (prompt, context, options) => {
  const cfg = options.cfg?.classifier_laya;
  if (!cfg || !cfg.enabled) return null;
  if (!isLayaAvailable()) return null;
  let answer;
  try {
    answer = await classifyWithLayaRaw(prompt, context, cfg.endpoint!, cfg.timeout_ms!);
  } catch (err) {
    // markUnavailable / warnLog are exercised in test/laya-classifier.test.ts
    return null;
  }
  if (answer.confidence < (cfg.confidence_threshold ?? 0.8)) return null;
  const top = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 2);
  const reason = top.map(([c, p]) => `${c} (${(p * 100).toFixed(0)}%)`).join('; ');
  return { category: answer.category, reason, confidence: answer.confidence };
});

describe('laya chain integration (Task 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLayaAvailability();
    vi.mocked(isLayaAvailable).mockReturnValue(true);
    vi.mocked(probeLaya).mockResolvedValue(true);
    vi.mocked(isOllamaAvailable).mockResolvedValue(true);
    vi.mocked(callOllama).mockResolvedValue(
      JSON.stringify({ category: 'simple', reason: 'from ollama', confidence: 0.9 })
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lays the local stage after the deterministic cache path and before the cloud/ollama legs', async () => {
    vi.mocked(classifyWithLayaRaw).mockResolvedValue(layaAnswer);
    const cfg: Config = { classifier_laya: layaCfg() };
    const result = await classifyPrompt('Explain the classification threshold 1', {
      cfg,
      model: 'gemma-primary',
      timeoutMs: 1234,
    });
    expect(classifyWithLayaRaw).toHaveBeenCalledTimes(1);
    expect(callOllama).not.toHaveBeenCalled(); // Laya answered first — cloud/ollama leg never reached
    expect(result.category).toBe('standard');
    expect(result.confidence).toBe(0.95);
    expect(result.reason).toContain('standard');
  });

  it('deterministic HINT path runs before Laya and blocks it', async () => {
    vi.mocked(classifyWithLayaRaw).mockImplementation(() => {
      throw new Error('should not be called');
    });
    const cfg: Config = { classifier_laya: layaCfg() };
    const result = await classifyPrompt('HINT: use group tactical\nexplain the momentum 2', {
      cfg,
      model: 'gemma-primary',
      timeoutMs: 1234,
    });
    expect(classifyWithLayaRaw).not.toHaveBeenCalled();
    expect(result).toHaveProperty('hintType', 'group');
    expect(result).toHaveProperty('hintTarget', 'tactical');
  });

  it('disabled Laya config keeps the chain identical — cloud/ollama leg used', async () => {
    vi.mocked(classifyWithLayaRaw).mockImplementation(() => {
      throw new Error('should not be called');
    });
    const cfg: Config = { classifier_laya: layaCfg({ enabled: false }) };
    const result = await classifyPrompt('Explain the momentum logic 3', {
      cfg,
      model: 'gemma-primary',
      fallbackModel: 'gemma-backup',
      timeoutMs: 1000,
      fallbackTimeoutMs: 500,
    });
    expect(classifyWithLayaRaw).not.toHaveBeenCalled();
    expect(result.category).toBe('simple'); // comes from the ollama mock
  });

  it('low confidence falls through to the next stage instead of returning fallback', async () => {
    vi.mocked(classifyWithLayaRaw).mockResolvedValue({
      ...layaAnswer,
      category: 'code_simple',
      confidence: 0.4, // below the 0.8 confidence_threshold
    });
    const cfg: Config = { classifier_laya: layaCfg() };
    const result = await classifyPrompt('Explain the wedged watchdog 4', {
      cfg,
      model: 'gemma-primary',
      fallbackModel: 'gemma-backup',
      timeoutMs: 1000,
      fallbackTimeoutMs: 500,
    });
    expect(classifyWithLayaRaw).toHaveBeenCalledTimes(1);
    expect(callOllama).toHaveBeenCalled(); // fell through to the cloud/ollama leg
    expect(result.category).toBe('simple');
  });

  it('unavailable Laya is transparent — the chain continues without error', async () => {
    vi.mocked(isLayaAvailable).mockReturnValue(false);
    const cfg: Config = { classifier_laya: layaCfg() };
    const result = await classifyPrompt('Explain the fallback semantics 5', {
      cfg,
      model: 'gemma-primary',
      timeoutMs: 1234,
    });
    expect(classifyWithLayaRaw).not.toHaveBeenCalled(); // never reached when unavailable
    expect(callOllama).toHaveBeenCalled();
    expect(result.category).toBe('simple');
  });
});
