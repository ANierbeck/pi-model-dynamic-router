// test/hint-classification.test.ts
// Unit tests for HINT classification — deterministic path and LLM fallback

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyPrompt, classifyStatically, detectHintDirectly } from '../src/content-classifier.js';
import type { ClassificationResult, HintClassificationResult, FullClassificationResult } from '../src/content-classifier.js';
import { resolveShortModelName } from '../src/utils.js';

// ── Mock for callOllama ─────────────────────────────────────────────────

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

  // F6 (2026-09-02): the colon is OPTIONAL. A user typing "HINT use
  // mistral-zai/glm-5-2 Please proceed…" (no colon) should still be
  // recognized. The guard against false positives is that HINT must be a
  // standalone token at the start (the word "hint" in natural prose like
  // "can I get a hint about…" must NOT match).
  describe('colon-optional (F6)', () => {
    it('recognizes HINT without a colon', () => {
      const r = detectHintDirectly('HINT use mistral-zai/glm-5-2 Please proceed');
      expect(r).not.toBeNull();
      expect(r?.hintType).toBe('model');
      expect(r?.hintTarget).toBe('mistral-zai/glm-5-2');
    });

    it('still recognizes HINT with a colon (unchanged)', () => {
      const r = detectHintDirectly('HINT: use mistral-medium-3.5');
      expect(r).not.toBeNull();
      expect(r?.hintType).toBe('model');
      expect(r?.hintTarget).toBe('mistral-medium-3.5');
    });

    it('does NOT match the word "hint" in natural prose (false-positive guard)', () => {
      expect(detectHintDirectly('can I get a hint about this code?')).toBeNull();
      expect(detectHintDirectly('hint me on this one')).toBeNull();
      expect(detectHintDirectly('a hint: the bug is in the parser')).toBeNull();
    });

    it('recognizes group hints without a colon too', () => {
      const r = detectHintDirectly('HINT use group tactical');
      expect(r).not.toBeNull();
      expect(r?.hintType).toBe('group');
      expect(r?.hintTarget).toBe('tactical');
    });

    // roborev job 451 LOW: the bare noun `gruppe`/`group` is NOT in the
    // lookahead — group hints go through GROUP_VERB_PREFIX ("use group X"),
    // so English and German behave symmetrically.
    it('does NOT match bare "HINT gruppe <x>" (German noun without verb — symmetric with English "group")', () => {
      const r = detectHintDirectly('HINT gruppe tactical');
      expect(r).toBeNull();
    });

    it('does NOT match bare "HINT group <x>" (English noun without verb)', () => {
      const r = detectHintDirectly('HINT group tactical');
      expect(r).toBeNull();
    });

    // roborev job 451 LOW: "HINT use" (verb with no model) must NOT parse
    // "use" as a model name — let the LLM classifier handle it.
    it('returns null for "HINT use" with no model (bare verb, no model after)', () => {
      const r = detectHintDirectly('HINT use');
      expect(r).toBeNull();
    });

    it('returns null for "HINT nutze" with no model (bare German verb)', () => {
      const r = detectHintDirectly('HINT nutze');
      expect(r).toBeNull();
    });
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

    it('"HINT: nutze gruppe" with no name → null', () => {
      expect(detectHintDirectly('HINT: nutze gruppe')).toBeNull();
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
    it('classifies normal requests without HINT', async () => {
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

    it('classifies simple requests', async () => {
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
  // resolveShortModelName takes a flat list of discovered refs (router.allDiscoveredRefs()),
  // not a model-groups object — group membership is resolved upstream by the caller.
  const allRefs = [
    'mistral/mistral-medium-3.5',
    'chutes/Qwen/Qwen3-32B-TEE',
    'anthropic/claude-3-sonnet',
    'openrouter/meta-llama/llama-3.1-70b',
  ];

  it('resolves short name to fully-qualified ref via endsWith match', () => {
    const result = resolveShortModelName('mistral-medium-3.5', allRefs);
    expect(result).toBe('mistral/mistral-medium-3.5');
  });

  it('returns already-qualified ref unchanged', () => {
    const result = resolveShortModelName('mistral/mistral-medium-3.5', allRefs);
    expect(result).toBe('mistral/mistral-medium-3.5');
  });

  it('returns null when short name is not found in any group', () => {
    const result = resolveShortModelName('typo-model-name', allRefs);
    expect(result).toBeNull();
  });

  it('stops at first match (break-on-first-match behavior)', () => {
    // Array.prototype.find() returns the first match in iteration order — intentional.
    const refs = ['providerA/same-model', 'providerB/same-model'];
    const result = resolveShortModelName('same-model', refs);
    expect(result).toBe('providerA/same-model');
  });

  it('resolves exact match (model stored without provider prefix)', () => {
    const refs = ['ollama/gemma4:12b-mlx', 'llama3.1:latest'];
    const result = resolveShortModelName('llama3.1:latest', refs);
    // Exact match on unqualified name — returns the stored ref, not null
    expect(result).toBe('llama3.1:latest');
  });

  it('returns null for empty ref list', () => {
    const result = resolveShortModelName('some-model', []);
    expect(result).toBeNull();
  });
});

// ── Compaction model-continuity hints ────────────────────────────────────
//
// During compaction, classifyPrompt() hints back to context.lastModel for
// continuity. That hint resolves through the same HINT-override path as an
// explicit user "HINT: <model>" prefix, which clears rate-limit cooldowns on
// the target so a deliberate user choice isn't silently blocked. But this
// hint is NOT a deliberate user choice — it's the router guessing. If
// lastModel just failed and is sitting in cooldown, hinting back to it would
// immediately clear that cooldown and retry the same broken/overloaded model
// again, every single compaction turn — observed in production as a tight
// repeated-retry loop that looked like the whole session had hung.
describe('compaction model-continuity hint', () => {
  it('hints back to lastModel when it is not in cooldown, tagged as auto', async () => {
    const result = await classifyPrompt('summarize the conversation', {
      context: {
        isCompaction: true,
        lastModel: 'mistral-zai/zai-glm-5-2',
        lastModelLimited: false,
      },
    });
    expect(result).toMatchObject({
      hintType: 'model',
      hintTarget: 'mistral-zai/zai-glm-5-2',
      origin: 'auto',
    });
  });

  it('does NOT hint back to lastModel when it is currently in cooldown', async () => {
    const result = await classifyPrompt('summarize the conversation', {
      context: {
        isCompaction: true,
        lastModel: 'mistral-zai/zai-glm-5-2',
        lastModelLimited: true,
      },
    });
    expect('hintType' in result).toBe(false);
    expect(result).toMatchObject({ category: 'code_complex' });
  });

  it('still routes small local models to strategic during compaction, regardless of cooldown', async () => {
    const result = await classifyPrompt('summarize the conversation', {
      context: {
        isCompaction: true,
        lastModel: 'ollama/gemma4:12b',
        lastModelLimited: false,
      },
    });
    expect('hintType' in result).toBe(false);
    expect(result).toMatchObject({ category: 'code_complex' });
  });

  it('an explicit user "HINT: <model>" prefix is not tagged as auto', () => {
    const r = detectHintDirectly('HINT: mistral-medium-3.5');
    expect(r?.origin).not.toBe('auto');
  });
});
