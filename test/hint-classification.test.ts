// test/hint-classification.test.ts
// Unit tests for HINT classification — deterministic path and LLM fallback

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyPrompt, classifyStatically, detectHintDirectly } from '../src/content-classifier.js';
import type { ClassificationResult, HintClassificationResult, FullClassificationResult } from '../src/content-classifier.js';
import { resolveShortModelName } from '../src/utils.js';

// ── Mock für callOllama ─────────────────────────────────────────────────

vi.mock('../src/ollama-utils.js', async () => {
  const actual = await vi.importActual('../src/ollama-utils.js');
  return {
    ...actual,
    callOllama: vi.fn(),
  };
});

// ── detectHintDirectly unit tests ────────────────────────────────────────

describe('detectHintDirectly()', () => {
  it('returns null for prompts without HINT prefix', () => {
    expect(detectHintDirectly('analyze this code')).toBeNull();
    expect(detectHintDirectly('what is 2+2?')).toBeNull();
  });

  it('returns null for empty HINT payload ("HINT: ")', () => {
    expect(detectHintDirectly('HINT: ')).toBeNull();
    expect(detectHintDirectly('HINT:  ')).toBeNull();
  });

  describe('model hints', () => {
    it('detects bare model name', () => {
      const r = detectHintDirectly('HINT: mistral-medium-3.5');
      expect(r).toMatchObject({ hintType: 'model', hintTarget: 'mistral-medium-3.5' });
    });

    it('detects "use <model>" (english)', () => {
      const r = detectHintDirectly('HINT: use mistral-medium-3.5 and analyze this');
      expect(r).toMatchObject({ hintType: 'model', hintTarget: 'mistral-medium-3.5' });
    });

    it('detects "nutze <model>" (german)', () => {
      const r = detectHintDirectly('HINT: nutze mistral-medium-3.5 und analysiere');
      expect(r).toMatchObject({ hintType: 'model', hintTarget: 'mistral-medium-3.5' });
    });

    it('detects qualified ref with provider prefix', () => {
      const r = detectHintDirectly('HINT: mistral/mistral-medium-3.5');
      expect(r).toMatchObject({ hintType: 'model', hintTarget: 'mistral/mistral-medium-3.5' });
    });

    it('strips trailing punctuation from model name', () => {
      const r = detectHintDirectly('HINT: use mistral-medium-3.5,');
      expect(r).toMatchObject({ hintType: 'model', hintTarget: 'mistral-medium-3.5' });
    });
  });

  describe('group hints', () => {
    it('detects "use group <name>" (english)', () => {
      const r = detectHintDirectly('HINT: use group tactical for this task');
      expect(r).toMatchObject({ hintType: 'group', hintTarget: 'tactical' });
    });

    it('detects "verwende Gruppe <name>" (german)', () => {
      const r = detectHintDirectly('HINT: verwende Gruppe tactical');
      expect(r).toMatchObject({ hintType: 'group', hintTarget: 'tactical' });
    });

    it('detects "nutze gruppe <name>" (german)', () => {
      const r = detectHintDirectly('HINT: nutze gruppe complex');
      expect(r).toMatchObject({ hintType: 'group', hintTarget: 'complex' });
    });

    it('detects "benutze Gruppe <name>" (german, benutz(e) form)', () => {
      const r = detectHintDirectly('HINT: benutze Gruppe tactical');
      expect(r).toMatchObject({ hintType: 'group', hintTarget: 'tactical' });
    });

    it('lowercases the group name', () => {
      const r = detectHintDirectly('HINT: use group TACTICAL');
      expect(r).toMatchObject({ hintType: 'group', hintTarget: 'tactical' });
    });
  });

  describe('incomplete group hints — must return null', () => {
    it('"HINT: use group" with no name → null (not misclassified as model "group")', () => {
      expect(detectHintDirectly('HINT: use group')).toBeNull();
    });

    it('"HINT: verwende Gruppe" with no name → null', () => {
      expect(detectHintDirectly('HINT: verwende Gruppe')).toBeNull();
    });

    it('"HINT: benutze Gruppe" with no name → null', () => {
      expect(detectHintDirectly('HINT: benutze Gruppe')).toBeNull();
    });
  });
});

// ── classifyPrompt HINT integration tests ───────────────────────────────

describe('HINT Classification', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('HINT Model Detection', () => {
    it('detects model hint (english) without calling LLM', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      const result = await classifyPrompt('HINT: use mistral-medium-3.5 and analyze this code');
      expect(result).toHaveProperty('hintType', 'model');
      expect(result).toHaveProperty('hintTarget', 'mistral-medium-3.5');
      expect(result).toHaveProperty('confidence', 1.0);
      expect(result.reason).toContain('HINT');
      expect(vi.mocked(callOllama)).not.toHaveBeenCalled();
    });

    it('detects model hint (german) without calling LLM', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      const result = await classifyPrompt('HINT: nutze mistral-medium-3.5 und analysiere diesen Code');
      expect(result).toHaveProperty('hintType', 'model');
      expect(result).toHaveProperty('hintTarget', 'mistral-medium-3.5');
      expect(vi.mocked(callOllama)).not.toHaveBeenCalled();
    });

    it('detects group hint without calling LLM', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      const result = await classifyPrompt('HINT: use group tactical for this task');
      expect(result).toHaveProperty('hintType', 'group');
      expect(result).toHaveProperty('hintTarget', 'tactical');
      expect(vi.mocked(callOllama)).not.toHaveBeenCalled();
    });

    it('detects bare model name without use-keyword', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      const result = await classifyPrompt('HINT: mistral-medium-3.5 analyze this');
      expect(result).toHaveProperty('hintType', 'model');
      expect(result).toHaveProperty('hintTarget', 'mistral-medium-3.5');
      expect(vi.mocked(callOllama)).not.toHaveBeenCalled();
    });
  });

  describe('HINT Fallback Handling', () => {
    it('falls through to LLM for "HINT: " with empty payload', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      vi.mocked(callOllama).mockResolvedValue(
        JSON.stringify({ category: 'fallback', reason: 'Empty HINT', confidence: 0.5 })
      );
      const result = await classifyPrompt('HINT: ');
      // detectHintDirectly returns null → classifyPrompt calls LLM
      expect(vi.mocked(callOllama)).toHaveBeenCalled();
    });

    it('falls through to LLM for incomplete group hint "HINT: use group"', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      vi.mocked(callOllama).mockResolvedValue(
        JSON.stringify({ category: 'fallback', reason: 'Incomplete group hint', confidence: 0.5 })
      );
      const result = await classifyPrompt('HINT: use group');
      // detectHintDirectly returns null → classifyPrompt calls LLM
      expect(vi.mocked(callOllama)).toHaveBeenCalled();
      expect(result).toHaveProperty('category', 'fallback');
    });
  });

  describe('Normale Klassifizierung (kein HINT)', () => {
    it('klassifiziert normale Anfragen ohne HINT', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      
      // Mock response ohne HINT
      vi.mocked(callOllama).mockResolvedValue(
        JSON.stringify({
          category: 'code_complex',
          reason: 'Complex coding task',
          confidence: 0.95
        })
      );

      const result = await classifyPrompt('Refactor this complex function');
      
      // Sollte normale ClassificationResult sein
      expect(result).toHaveProperty('category', 'code_complex');
      expect(result).not.toHaveProperty('hintType');
      expect(result).not.toHaveProperty('hintTarget');
    });

    it('klassifiziert einfache Anfragen', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      
      vi.mocked(callOllama).mockResolvedValue(
        JSON.stringify({
          category: 'simple',
          reason: 'Simple question',
          confidence: 0.9
        })
      );

      const result = await classifyPrompt('What is the capital of France?');
      
      expect(result).toHaveProperty('category', 'simple');
      expect(result).toHaveProperty('confidence', 0.9);
    });
  });

  describe('Static Classification Fallback', () => {
    it('falls back to static classification when LLM fails', async () => {
      const { callOllama } = await import('../src/ollama-utils.js');
      
      // Mock callOllama to throw error
      vi.mocked(callOllama).mockRejectedValue(new Error('Ollama not available'));

      // Use a prompt that classifyStatically maps to 'simple' (not 'fallback')
      const result = await classifyPrompt('What is the capital of France?', { 
        allowStaticFallback: true 
      });
      
      // Should use static classification
      // "What is the capital of France?" is classified as 'simple' by classifyStatically
      const staticResult = classifyStatically('What is the capital of France?');
      expect(result.category).toBe(staticResult.category);
      expect(result.category).toBe('simple');
    });
  });

  describe('Typ-Sicherheit', () => {
    it('HintClassificationResult hat keine category', () => {
      const hintResult: HintClassificationResult = {
        reason: 'User specified model via HINT',
        confidence: 1.0,
        hintType: 'model',
        hintTarget: 'mistral-medium-3.5'
      };
      
      // Sollte kein category Feld haben
      expect(hintResult).not.toHaveProperty('category');
      expect(hintResult.hintType).toBe('model');
      expect(hintResult.hintTarget).toBe('mistral-medium-3.5');
    });

    it('ClassificationResult hat category aber kein hintType', () => {
      const normalResult: ClassificationResult = {
        category: 'code_complex',
        reason: 'Complex task',
        confidence: 0.95
      };
      
      expect(normalResult).toHaveProperty('category', 'code_complex');
      expect(normalResult).not.toHaveProperty('hintType');
      expect(normalResult).not.toHaveProperty('hintTarget');
    });
  });
});

describe('resolveShortModelName()', () => {
  const modelGroups = {
    tactical: {
      models: ['mistral/mistral-medium-3.5', 'chutes/Qwen/Qwen3-32B-TEE'],
    },
    strategic: {
      models: ['anthropic/claude-3-sonnet', 'openrouter/meta-llama/llama-3.1-70b'],
    },
  };

  it('resolves short name to fully-qualified ref via endsWith match', () => {
    const result = resolveShortModelName('mistral-medium-3.5', modelGroups);
    expect(result).toBe('mistral/mistral-medium-3.5');
  });

  it('returns already-qualified ref unchanged', () => {
    const result = resolveShortModelName('mistral/mistral-medium-3.5', modelGroups);
    expect(result).toBe('mistral/mistral-medium-3.5');
  });

  it('returns null when short name is not found in any group', () => {
    const result = resolveShortModelName('typo-model-name', modelGroups);
    expect(result).toBeNull();
  });

  it('stops at first match (break-on-first-match behavior)', () => {
    const groups = {
      // Object.values() iterates in insertion order for non-integer string keys (ES2015+),
      // so groupA is always searched before groupB — this is intentional and spec-compliant.
      groupA: { models: ['providerA/same-model'] },
      groupB: { models: ['providerB/same-model'] },
    };
    const result = resolveShortModelName('same-model', groups);
    expect(result).toBe('providerA/same-model');
  });

  it('resolves exact match (model stored without provider prefix)', () => {
    const groups = { local: { models: ['ollama/gemma4:12b-mlx', 'llama3.1:latest'] } };
    const result = resolveShortModelName('llama3.1:latest', groups);
    // Exact match on unqualified name — returns the stored ref, not null
    expect(result).toBe('llama3.1:latest');
  });

  it('returns null for empty model groups', () => {
    const result = resolveShortModelName('some-model', {});
    expect(result).toBeNull();
  });
});
