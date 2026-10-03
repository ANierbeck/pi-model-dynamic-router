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

      // Cloud-first (2026-09-27): cloud succeeds, so Ollama must NEVER be
      // touched. callOllama is still mocked to reject so a regression that
      // restores the old Ollama-first order would surface as a failing
      // assertion, not as a silently-passing test.
      expect(callOllama).not.toHaveBeenCalled();
      expect(completeSimple).toHaveBeenCalledTimes(1);
      expect(findModel).toHaveBeenCalledWith('prov/cloud-a');
      expect(result).toEqual({ category: 'code_simple', reason: 'from cloud', confidence: 0.85 });
    });

    it('never sends a prompt to an excluded model, even from a stale probed list (owner decision 2026-10-03)', async () => {
      // `exclude` means "never use this model, for anything" — including
      // classification. The probed list is cached at scan time, so it may
      // still carry a ref the user excluded afterwards (sourcelume
      // 2026-10-03: openrouter/stealth/space-bunny-alpha classified prompts).
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi.fn().mockResolvedValue(
        cloudReply({ category: 'simple', reason: 'from allowed', confidence: 0.9 })
      );
      const findModel = vi.fn().mockReturnValue(mockModel);

      await classifyPrompt('Rename this helper so the excluded stealth model never sees it', {
        allowCloudFallback: true,
        cfg: { exclude: { models: ['openrouter/stealth/*'] } } as any,
        cache: { classifier_fallback_models: ['openrouter/stealth/space-bunny-alpha', 'prov/cloud-a'] } as any,
        completeSimple,
        findModel,
      });

      expect(findModel).not.toHaveBeenCalledWith('openrouter/stealth/space-bunny-alpha');
      expect(findModel).toHaveBeenCalledWith('prov/cloud-a');
      expect(completeSimple).toHaveBeenCalledTimes(1);
    });

    it('falls back to Ollama as a LAST RESORT when the entire cloud chain fails', async () => {
      vi.mocked(callOllama)
        .mockRejectedValueOnce(new Error('ECONNREFUSED')) // primary
        .mockResolvedValueOnce( // fallback
          ollamaReply({ category: 'simple', reason: 'local last resort', confidence: 0.8 })
        );
      const completeSimple = vi.fn().mockResolvedValue({ errorMessage: 'provider 500', stopReason: 'error' });
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Explain the difference between let and const briefly', {
        model: 'gemma-primary',
        fallbackModel: 'gemma-backup',
        allowCloudFallback: true,
        cfg: {} as any,
        cache: { classifier_fallback_models: ['prov/cloud-a'] } as any,
        completeSimple,
        findModel,
      });

      // Cloud was tried first (and failed) before Ollama was touched at all.
      expect(completeSimple).toHaveBeenCalledTimes(1);
      expect(callOllama).toHaveBeenCalledTimes(2);
      expect(vi.mocked(callOllama).mock.calls[0]?.[0]).toBe('gemma-primary');
      expect(vi.mocked(callOllama).mock.calls[1]?.[0]).toBe('gemma-backup');
      expect(result).toEqual({ category: 'simple', reason: 'local last resort', confidence: 0.8 });
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

    it('rejects a spurious hint:* echo from a cloud model and tries the next one (voxtral regression, review 2026-09-26 Important #1)', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      // Pinned model echoes the HINT it copied out of the narration context —
      // the exact voxtral-small incident mode (2026-09-26). The user prompt
      // itself contains NO HINT, so the reply is spurious and must be skipped
      // like any other bad reply instead of being returned raw (which
      // polluted lastClassifiedCategory and misrouted via CATEGORY_TO_GROUP
      // miss → 'fallback' → tactical).
      const completeSimple = vi
        .fn()
        .mockResolvedValueOnce(
          cloudReply({ category: 'hint:group:tactical', reason: 'copied from context', confidence: 1.0 })
        )
        .mockResolvedValueOnce(
          cloudReply({ category: 'standard', reason: 'from cached', confidence: 0.8 })
        );
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Check the pull request comments about our middleware stack', {
        allowCloudFallback: true,
        pinnedCloudModel: 'prov/pinned',
        cfg: {} as any,
        cache: { classifier_fallback_models: ['prov/cached'] } as any,
        completeSimple,
        findModel,
        context: {
          previousUserMessage: 'Can you refactor the auth module next?',
          lastAssistantSnippet:
            '[router] HINT: use group tactical — routing the next request to a stronger model. The previous task is complete.',
        },
      });

      // The pinned model was tried first and REJECTED; the cached model
      // produced the real answer.
      expect(completeSimple).toHaveBeenCalledTimes(2);
      expect(findModel.mock.calls[0]?.[0]).toBe('prov/pinned');
      expect(findModel.mock.calls[1]?.[0]).toBe('prov/cached');
      expect(result).toEqual({ category: 'standard', reason: 'from cached', confidence: 0.8 });
      // No hint semantics may leak into the routed classification.
      expect((result as any).hintType).toBeUndefined();
      expect((result as any).hintTarget).toBeUndefined();
      expect((result as any).category ?? '').not.toMatch(/^hint:/);
    });

    it('converts a legitimate mid-prompt HINT reply from a cloud model into a processed hint', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi
        .fn()
        .mockResolvedValueOnce(
          cloudReply({ category: 'hint:group:strategic', reason: 'user asked for strategic', confidence: 1.0 })
        );
      const findModel = vi.fn().mockReturnValue(mockModel);

      // The HINT is mid-prompt (not at the start), so detectHintDirectly does
      // not preempt it — the LLM legitimately sees it and may answer with a
      // hint:* category, which the cloud loop must convert EXACTLY like the
      // Ollama path (review 2026-09-26, Important #1).
      const result = await classifyPrompt(
        'Please review the auth refactor and HINT: use group strategic for the follow-up question',
        {
          allowCloudFallback: true,
          cfg: {} as any,
          cache: { classifier_fallback_models: ['prov/cloud-a'] } as any,
          completeSimple,
          findModel,
        }
      );

      expect(completeSimple).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        reason: 'user asked for strategic',
        confidence: 1.0,
        hintType: 'group',
        hintTarget: 'strategic',
      });
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

    it('moves a pinned model that is already in the cached list to position 0 — no duplicate tries (review 2026-09-26, Minor #3)', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi.fn().mockResolvedValue(
        cloudReply({ category: 'exploration', reason: 'from pinned', confidence: 0.9 })
      );
      // findModel resolves refs in call order: the pinned ref must be FIRST.
      const findModel = vi.fn((ref: string) => (ref === 'prov/cached-b' || ref === 'prov/cached-a' ? mockModel : undefined));

      const result = await classifyPrompt('Merge the release branch notes into our changelog today', {
        allowCloudFallback: true,
        // 'prov/cached-b' sits at list position 1 — the pinned contract says
        // it must still be tried FIRST, deduplicated, not skipped in place.
        pinnedCloudModel: 'prov/cached-b',
        cfg: {} as any,
        cache: { classifier_fallback_models: ['prov/cached-a', 'prov/cached-b'] } as any,
        completeSimple,
        findModel,
      });

      expect(findModel.mock.calls[0]?.[0]).toBe('prov/cached-b');
      expect(completeSimple).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ category: 'exploration', reason: 'from pinned', confidence: 0.9 });
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
    // Owner decision 2026-10-03 (sourcelume over-hinting): escalation may
    // fire ONLY for genuine upgrade categories (code_complex / design /
    // planning). The target group comes from CATEGORY_TO_GROUP — the same
    // table the plain category path uses — not from a second tier table.
    // Every other category must return a plain classification: the old
    // tier comparison converted nearly every ordinary prompt into a
    // hint:group:tactical → claude-bridge/claude-opus-5-5 lock-in (14/15
    // sourcelume turns, 74% of traffic on the free model otherwise).
    it('escalates a code_complex task to the tactical group (category table, not tier table)', async () => {
      vi.mocked(callOllama).mockResolvedValueOnce(
        ollamaReply({ category: 'code_complex', reason: 'complex task', confidence: 0.9 })
      );

      const result = await classifyPrompt('Design a distributed queue with retries please', {
        context: { lastModel: 'unknown/cheap-model' },
      });

      expect('hintType' in result).toBe(true);
      if ('hintType' in result) {
        expect(result.hintType).toBe('group');
        // CATEGORY_TO_GROUP['code_complex'] === 'tactical' — the OLD tier
        // table said 'strategic' and over-rode the category route.
        expect(result.hintTarget).toBe('tactical');
        expect(result.confidence).toBe(0.95);
      }
    });

    it('does NOT escalate an ordinary standard task — plain category decides the group', async () => {
      vi.mocked(callOllama).mockResolvedValueOnce(
        ollamaReply({ category: 'standard', reason: 'ordinary task', confidence: 0.9 })
      );

      const result = await classifyPrompt('Set the PR to ready please', {
        context: { lastModel: 'unknown/cheap-model' },
      });

      expect('hintType' in result).toBe(false);
      expect(result.category).toBe('standard');
    });

    it('does not escalate a trivial task', async () => {
      vi.mocked(callOllama).mockResolvedValueOnce(
        ollamaReply({ category: 'trivial', reason: 'trivial task', confidence: 0.9 })
      );

      const result = await classifyPrompt('Show me the todo list in this repository now', {
        context: { lastModel: 'unknown/cheap-model' },
      });

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
