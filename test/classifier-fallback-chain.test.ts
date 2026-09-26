// Regression tests for the classifyPrompt fallback chain (content-classifier.ts):
//
//   primary Ollama model → fallback Ollama model → cloud fallback (pi's
//   completeSimple) → static classification
//
// Only the Ollama HTTP client (ollama-utils.ts) is mocked — prompt building,
// static classification, escalation, and hint detection run as real code.
//
// IMPORTANT: every test uses a UNIQUE prompt. classifyPrompt caches LLM
// results per prompt string (module-level, 5-minute TTL); identical prompts
// across tests would hit that cache and skip the code under test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callOllama, isOllamaAvailable } from '../src/ollama-utils.ts';
import { classifyPrompt } from '../src/content-classifier.ts';
import type { FullClassificationResult } from '../src/content-classifier.ts';

vi.mock('../src/ollama-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ollama-utils.ts')>();
  return { ...actual, callOllama: vi.fn(), isOllamaAvailable: vi.fn() };
});

const mockModel = { id: 'test-model', provider: 'prov' };

const ollamaReply = (r: FullClassificationResult) => JSON.stringify(r);
const cloudReply = (r: FullClassificationResult) => ({
  content: [{ type: 'text', text: JSON.stringify(r) }],
  stopReason: 'stop',
});

describe('classifyPrompt fallback chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Daemon reachable by default — individual tests opt into the
    // "Ollama down" scenarios by overriding this mock.
    vi.mocked(isOllamaAvailable).mockResolvedValue(true);
  });

  describe('Ollama paths', () => {
    it('classifies with the primary Ollama model when it responds', async () => {
      vi.mocked(callOllama).mockResolvedValueOnce(
        ollamaReply({ category: 'simple', reason: 'from primary', confidence: 0.9 })
      );

      const result = await classifyPrompt('Explain async await semantics briefly please', {
        model: 'gemma-primary',
        timeoutMs: 1234,
      });

      expect(callOllama).toHaveBeenCalledTimes(1);
      expect(vi.mocked(callOllama).mock.calls[0]?.[0]).toBe('gemma-primary');
      expect(vi.mocked(callOllama).mock.calls[0]?.[2]).toEqual({ timeoutMs: 1234 });
      expect(result).toEqual({ category: 'simple', reason: 'from primary', confidence: 0.9 });
    });

    it('retries with the fallback model when the primary Ollama call fails', async () => {
      vi.mocked(callOllama)
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(
          ollamaReply({ category: 'standard', reason: 'from fallback', confidence: 0.8 })
        );

      const result = await classifyPrompt('What are the differences between grpc and rest', {
        model: 'gemma-primary',
        fallbackModel: 'gemma-backup',
        timeoutMs: 1000,
        fallbackTimeoutMs: 500,
      });

      expect(callOllama).toHaveBeenCalledTimes(2);
      expect(vi.mocked(callOllama).mock.calls[0]?.[0]).toBe('gemma-primary');
      expect(vi.mocked(callOllama).mock.calls[0]?.[2]).toEqual({ timeoutMs: 1000 });
      expect(vi.mocked(callOllama).mock.calls[1]?.[0]).toBe('gemma-backup');
      expect(vi.mocked(callOllama).mock.calls[1]?.[2]).toEqual({ timeoutMs: 500 });
      expect(result).toEqual({ category: 'standard', reason: 'from fallback', confidence: 0.8 });
    });

    it('does not retry the fallback model when it equals the primary', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await classifyPrompt('Why does the sun shine during summer days', {
        model: 'same-model',
        fallbackModel: 'same-model',
      });

      expect(callOllama).toHaveBeenCalledTimes(1);
      expect(result.category).toBe('fallback');
      expect(result.reason).toContain('Ollama unavailable');
    });

    it('returns the fallback category (never throws) when both Ollama models fail', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await classifyPrompt('How do we test the router fallback chain here', {
        model: 'gemma-primary',
        fallbackModel: 'gemma-backup',
        allowCloudFallback: false,
        allowStaticFallback: false,
      });

      // classifyPrompt must NOT throw — it degrades to a routed fallback so
      // the stream can continue via the fallback group.
      expect(result.category).toBe('fallback');
      expect(result.reason).toContain('Ollama unavailable');
    });
  });

  describe('Ollama availability probe (isOllamaAvailable)', () => {
    it('skips both Ollama attempts and uses the cloud fallback when the daemon is unreachable', async () => {
      vi.mocked(isOllamaAvailable).mockResolvedValue(false);
      vi.mocked(callOllama).mockResolvedValue(
        ollamaReply({ category: 'trivial', reason: 'must not be used', confidence: 1 })
      );
      const completeSimple = vi.fn().mockResolvedValue(
        cloudReply({ category: 'simple', reason: 'from cloud', confidence: 0.9 })
      );
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Probe reports down so use the cloud classifiers', {
        allowCloudFallback: true,
        cfg: {} as any,
        cache: { classifier_fallback_models: ['prov/cloud-a'] } as any,
        completeSimple,
        findModel,
      });

      expect(callOllama).not.toHaveBeenCalled();
      expect(completeSimple).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ category: 'simple', reason: 'from cloud', confidence: 0.9 });
    });

    it('degrades to the static classifier when unreachable and cloud is disabled', async () => {
      vi.mocked(isOllamaAvailable).mockResolvedValue(false);

      const result = await classifyPrompt('refactor the whole parser when ollama is unreachable', {
        allowCloudFallback: false,
        allowStaticFallback: true,
      });

      expect(callOllama).not.toHaveBeenCalled();
      expect(result.category).toBe('code_complex');
    });
  });

  describe('cloud fallback paths', () => {
    it('classifies via completeSimple when both Ollama models fail', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi.fn().mockResolvedValue(
        cloudReply({ category: 'code_simple', reason: 'from cloud', confidence: 0.85 })
      );
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Please add a small import statement to that file', {
        allowCloudFallback: true,
        cfg: {} as any,
        cache: { classifier_fallback_models: ['prov/cloud-a'] } as any,
        completeSimple,
        findModel,
      });

      expect(callOllama).toHaveBeenCalledTimes(2);
      expect(completeSimple).toHaveBeenCalledTimes(1);
      expect(findModel).toHaveBeenCalledWith('prov/cloud-a');
      expect(result).toEqual({ category: 'code_simple', reason: 'from cloud', confidence: 0.85 });
    });

    it('tries the next cached model when a cloud model fails', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi
        .fn()
        .mockResolvedValueOnce({ errorMessage: 'provider 500', stopReason: 'error' })
        .mockResolvedValueOnce(
          cloudReply({ category: 'design', reason: 'from cloud b', confidence: 0.9 })
        );
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Design a database schema for user settings', {
        allowCloudFallback: true,
        cfg: {} as any,
        cache: { classifier_fallback_models: ['prov/cloud-a', 'prov/cloud-b'] } as any,
        completeSimple,
        findModel,
      });

      expect(completeSimple).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ category: 'design', reason: 'from cloud b', confidence: 0.9 });
    });

    it('never calls the cloud fallback when allowCloudFallback is false', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi.fn();
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Compare the two sorting algorithms for me now', {
        allowCloudFallback: false,
        cfg: {} as any,
        cache: { classifier_fallback_models: ['prov/cloud-a'] } as any,
        completeSimple,
        findModel,
        allowStaticFallback: false,
      });

      expect(completeSimple).not.toHaveBeenCalled();
      expect(result.category).toBe('fallback');
    });

    it('falls through an empty cloud candidate list to static classification', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));

      // No probed cache, no discovered models, no configured free models —
      // the cloud loop has nothing to try and must fall through to the
      // static classifier (allowStaticFallback: true).
      const result = await classifyPrompt('Explain what a closure is briefly to me', {
        allowCloudFallback: true,
        cfg: { providers: {} } as any,
        cache: { classifier_fallback_models: [], available_models: [] } as any,
        completeSimple: vi.fn(),
        findModel: vi.fn(),
        allowStaticFallback: true,
      });

      // Real classifyStatically runs: 'explain'/'briefly' → simple.
      expect(result.category).toBe('simple');
      expect(result.reason).toContain('Simple question');
    });
  });

  describe('pinnedCloudModel (dynamic group classifier_cloud_model)', () => {
    it('tries the pinned cloud model FIRST — before the probe-verified list', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi
        .fn()
        .mockResolvedValue(cloudReply({ category: 'standard', reason: 'from pinned', confidence: 0.9 }));
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Summarize the router config differences for me', {
        allowCloudFallback: true,
        pinnedCloudModel: 'prov/pinned',
        cfg: {} as any,
        cache: { classifier_fallback_models: ['prov/cached'] } as any,
        completeSimple,
        findModel,
      });

      // The pinned model must be resolved (and used) before the cached one —
      // success on the pinned model means the cached ref is never resolved.
      expect(findModel).toHaveBeenCalledTimes(1);
      expect(findModel).toHaveBeenCalledWith('prov/pinned');
      expect(completeSimple).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ category: 'standard', reason: 'from pinned', confidence: 0.9 });
    });

    it('skips an unresolvable pinned model and continues with the cached list', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi
        .fn()
        .mockResolvedValue(cloudReply({ category: 'planning', reason: 'from cached', confidence: 0.8 }));
      const findModel = vi.fn((ref: string) => (ref === 'prov/pinned' ? undefined : mockModel));

      const result = await classifyPrompt('Prioritize the open tasks on our roadmap now', {
        allowCloudFallback: true,
        pinnedCloudModel: 'prov/pinned',
        cfg: {} as any,
        cache: { classifier_fallback_models: ['prov/cached'] } as any,
        completeSimple,
        findModel,
      });

      expect(findModel).toHaveBeenCalledTimes(2);
      expect(findModel.mock.calls[0]?.[0]).toBe('prov/pinned');
      expect(findModel.mock.calls[1]?.[0]).toBe('prov/cached');
      expect(result).toEqual({ category: 'planning', reason: 'from cached', confidence: 0.8 });
    });
  });

  describe('escalation integration', () => {
    it('escalates to a strategic group hint for complex tasks on a cheap last model', async () => {
      vi.mocked(callOllama).mockResolvedValueOnce(
        ollamaReply({ category: 'code_complex', reason: 'complex task', confidence: 0.9 })
      );

      const result = await classifyPrompt('Design a distributed queue with retries please', {
        context: { lastModel: 'unknown/cheap-model' },
      });

      expect('hintType' in result).toBe(true);
      if ('hintType' in result) {
        expect(result.hintType).toBe('group');
        expect(result.hintTarget).toBe('strategic');
        expect(result.confidence).toBe(0.95);
      }
    });

    it('does not escalate when the last model already matches the task tier', async () => {
      vi.mocked(callOllama).mockResolvedValueOnce(
        ollamaReply({ category: 'trivial', reason: 'trivial task', confidence: 0.9 })
      );

      const result = await classifyPrompt('Show me the todo list in this repository now', {
        context: { lastModel: 'unknown/cheap-model' },
      });

      // trivial → cheap tier; unscored last model → cheap tier; no change.
      expect('hintType' in result).toBe(false);
      expect(result.category).toBe('trivial');
    });
  });

  describe('error handling', () => {
    it('degrades to the fallback category on invalid JSON from Ollama', async () => {
      vi.mocked(callOllama).mockResolvedValue('This is not JSON at all');

      const result = await classifyPrompt('Tell me how the classifier handles broken replies', {
        model: 'gemma-primary',
        fallbackModel: 'gemma-backup',
        allowCloudFallback: false,
        allowStaticFallback: false,
      });

      // Both attempts return invalid JSON → both throw → fallback result.
      expect(callOllama).toHaveBeenCalledTimes(2);
      expect(result.category).toBe('fallback');
    });

    it('handles an empty prompt without throwing', async () => {
      vi.mocked(callOllama).mockResolvedValueOnce(
        ollamaReply({ category: 'trivial', reason: 'empty prompt', confidence: 0.8 })
      );

      const result = await classifyPrompt('');

      expect(result.category).toBe('trivial');
    });
  });
});
