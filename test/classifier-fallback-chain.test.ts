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
import { PROBE_SIGNATURE } from '../src/classifier-cloud-probe.ts';
import { callOllama, isOllamaAvailable } from '../src/ollama-utils.ts';
import { classifyPrompt } from '../src/content-classifier.ts';
import type { FullClassificationResult } from '../src/content-classifier.ts';
import { localModelCache } from './helpers/local-model-cache.ts';

vi.mock('../src/ollama-utils.ts', async (importOriginal) =>
  (await import('./helpers/ollama-mock.ts')).ollamaMockPatched(await importOriginal())
);

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
      expect(result.category).toBe('continue');
      expect(result.reason).toContain('Ollama unavailable');
    });

    it('returns the fallback category (never throws) when both Ollama models fail', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await classifyPrompt('How do we test the router fallback chain here', {
        model: 'gemma-primary',
        fallbackModel: 'gemma-backup',
        allowCloudChain: false,
        allowStaticFallback: false,
      });

      // classifyPrompt must NOT throw — it degrades to a routed fallback so
      // the stream can continue via the fallback group.
      expect(result.category).toBe('continue');
      expect(result.reason).toContain('Ollama unavailable');
    });
  });

  describe('Ollama availability probe (isOllamaAvailable)', () => {
    it('skips both Ollama attempts and uses the cloud fallback when the daemon is unreachable', async () => {
      vi.mocked(isOllamaAvailable).mockResolvedValue(false);
      vi.mocked(callOllama).mockResolvedValue(
        ollamaReply({ category: 'simple', reason: 'must not be used', confidence: 1 })
      );
      const completeSimple = vi
        .fn()
        .mockResolvedValue(
          cloudReply({ category: 'simple', reason: 'from cloud', confidence: 0.9 })
        );
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Probe reports down so use the cloud classifiers', {
        allowCloudChain: true,
        cfg: {} as any,
        cache: {
          classifier_cloud_models: ['prov/cloud-a'],
          classifier_cloud_probe_sig: PROBE_SIGNATURE,
        } as any,
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
        allowCloudChain: false,
        allowStaticFallback: true,
      });

      expect(callOllama).not.toHaveBeenCalled();
      expect(result.category).toBe('code_complex');
    });
  });

  describe('cloud fallback paths', () => {
    it('classifies via completeSimple when both Ollama models fail', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi
        .fn()
        .mockResolvedValue(
          cloudReply({ category: 'code_simple', reason: 'from cloud', confidence: 0.85 })
        );
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Please add a small import statement to that file', {
        allowCloudChain: true,
        cfg: {} as any,
        cache: {
          classifier_cloud_models: ['prov/cloud-a'],
          classifier_cloud_probe_sig: PROBE_SIGNATURE,
        } as any,
        completeSimple,
        findModel,
      });

      // No local model is pinned or derived here (empty cache), so the local
      // leg is skipped and the cloud chain answers. The local-first order with
      // a usable local model is pinned in test/classifier-local-first.test.ts.
      expect(callOllama).not.toHaveBeenCalled();
      expect(completeSimple).toHaveBeenCalledTimes(1);
      expect(findModel).toHaveBeenCalledWith('prov/cloud-a');
      expect(result).toEqual({ category: 'code_simple', reason: 'from cloud', confidence: 0.85 });
    });

    it('never sends a prompt to an excluded model, even from a stale probed list (owner decision 2026-10-03)', async () => {
      // `exclude` means "never use this model, for anything" — including
      // classification. The probed list is cached at scan time, so it may
      // still carry a ref the user excluded afterwards (live finding
      // 2026-10-03: openrouter/stealth/space-bunny-alpha classified prompts).
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi
        .fn()
        .mockResolvedValue(
          cloudReply({ category: 'simple', reason: 'from allowed', confidence: 0.9 })
        );
      const findModel = vi.fn().mockReturnValue(mockModel);

      await classifyPrompt('Rename this helper so the excluded stealth model never sees it', {
        allowCloudChain: true,
        cfg: { exclude: { models: ['openrouter/stealth/*'] } } as any,
        cache: {
          classifier_cloud_models: ['openrouter/stealth/space-bunny-alpha', 'prov/cloud-a'],
          classifier_cloud_probe_sig: PROBE_SIGNATURE,
        } as any,
        completeSimple,
        findModel,
      });

      expect(findModel).not.toHaveBeenCalledWith('openrouter/stealth/space-bunny-alpha');
      expect(findModel).toHaveBeenCalledWith('prov/cloud-a');
      expect(completeSimple).toHaveBeenCalledTimes(1);
    });

    it('answers with the local fallback model before the cloud chain (local first)', async () => {
      vi.mocked(callOllama)
        .mockRejectedValueOnce(new Error('ECONNREFUSED')) // primary
        .mockResolvedValueOnce(
          // fallback
          ollamaReply({ category: 'simple', reason: 'local fallback', confidence: 0.8 })
        );
      const completeSimple = vi
        .fn()
        .mockResolvedValue({ errorMessage: 'provider 500', stopReason: 'error' });
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Explain the difference between let and const briefly', {
        model: 'gemma-primary',
        fallbackModel: 'gemma-backup',
        allowCloudChain: true,
        cfg: {} as any,
        cache: {
          classifier_cloud_models: ['prov/cloud-a'],
          classifier_cloud_probe_sig: PROBE_SIGNATURE,
        } as any,
        completeSimple,
        findModel,
      });

      // The local backup answered, so the cloud chain was never reached.
      expect(callOllama).toHaveBeenCalledTimes(2);
      expect(vi.mocked(callOllama).mock.calls[0]?.[0]).toBe('gemma-primary');
      expect(vi.mocked(callOllama).mock.calls[1]?.[0]).toBe('gemma-backup');
      expect(completeSimple).not.toHaveBeenCalled();
      expect(result).toEqual({ category: 'simple', reason: 'local fallback', confidence: 0.8 });
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
        allowCloudChain: true,
        cfg: {} as any,
        cache: {
          classifier_cloud_models: ['prov/cloud-a', 'prov/cloud-b'],
          classifier_cloud_probe_sig: PROBE_SIGNATURE,
        } as any,
        completeSimple,
        findModel,
      });

      expect(completeSimple).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ category: 'design', reason: 'from cloud b', confidence: 0.9 });
    });

    it('never calls the cloud fallback when allowCloudChain is false', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi.fn();
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Compare the two sorting algorithms for me now', {
        allowCloudChain: false,
        cfg: {} as any,
        cache: {
          classifier_cloud_models: ['prov/cloud-a'],
          classifier_cloud_probe_sig: PROBE_SIGNATURE,
        } as any,
        completeSimple,
        findModel,
        allowStaticFallback: false,
      });

      expect(completeSimple).not.toHaveBeenCalled();
      expect(result.category).toBe('continue');
    });

    it('rejects a spurious hint:* echo from a cloud model and tries the next one (voxtral regression, review 2026-09-26 Important #1)', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      // Pinned model echoes the HINT it copied out of the narration context —
      // the exact voxtral-small incident mode (2026-09-26). The user prompt
      // itself contains NO HINT, so the reply is spurious and must be skipped
      // like any other bad reply instead of being returned raw (which
      // polluted lastClassifiedCategory and misrouted via CATEGORY_TO_GROUP
      // miss → 'continue' → tactical).
      const completeSimple = vi
        .fn()
        .mockResolvedValueOnce(
          cloudReply({
            category: 'hint:group:tactical',
            reason: 'copied from context',
            confidence: 1.0,
          })
        )
        .mockResolvedValueOnce(
          cloudReply({ category: 'standard', reason: 'from cached', confidence: 0.8 })
        );
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt(
        'Check the pull request comments about our middleware stack',
        {
          allowCloudChain: true,
          pinnedCloudModel: 'prov/pinned',
          cfg: {} as any,
          cache: {
            classifier_cloud_models: ['prov/cached'],
            classifier_cloud_probe_sig: PROBE_SIGNATURE,
          } as any,
          completeSimple,
          findModel,
          context: {
            previousUserMessage: 'Can you refactor the auth module next?',
            lastAssistantSnippet:
              '[router] HINT: use group tactical — routing the next request to a stronger model. The previous task is complete.',
          },
        }
      );

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
      const completeSimple = vi.fn().mockResolvedValueOnce(
        cloudReply({
          category: 'hint:group:strategic',
          reason: 'user asked for strategic',
          confidence: 1.0,
        })
      );
      const findModel = vi.fn().mockReturnValue(mockModel);

      // The HINT is mid-prompt (not at the start), so detectHintDirectly does
      // not preempt it — the LLM legitimately sees it and may answer with a
      // hint:* category, which the cloud loop must convert EXACTLY like the
      // Ollama path (review 2026-09-26, Important #1).
      const result = await classifyPrompt(
        'Please review the auth refactor and HINT: use group strategic for the follow-up question',
        {
          allowCloudChain: true,
          cfg: {} as any,
          cache: {
            classifier_cloud_models: ['prov/cloud-a'],
            classifier_cloud_probe_sig: PROBE_SIGNATURE,
          } as any,
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
        allowCloudChain: true,
        cfg: { providers: {} } as any,
        cache: {
          classifier_cloud_models: [],
          classifier_cloud_probe_sig: PROBE_SIGNATURE,
          available_models: [],
        } as any,
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
        .mockResolvedValue(
          cloudReply({ category: 'standard', reason: 'from pinned', confidence: 0.9 })
        );
      const findModel = vi.fn().mockReturnValue(mockModel);

      const result = await classifyPrompt('Summarize the router config differences for me', {
        allowCloudChain: true,
        pinnedCloudModel: 'prov/pinned',
        cfg: {} as any,
        cache: {
          classifier_cloud_models: ['prov/cached'],
          classifier_cloud_probe_sig: PROBE_SIGNATURE,
        } as any,
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
      const completeSimple = vi
        .fn()
        .mockResolvedValue(
          cloudReply({ category: 'standard', reason: 'from pinned', confidence: 0.9 })
        );
      // findModel resolves refs in call order: the pinned ref must be FIRST.
      const findModel = vi.fn((ref: string) =>
        ref === 'prov/cached-b' || ref === 'prov/cached-a' ? mockModel : undefined
      );

      const result = await classifyPrompt(
        'Merge the release branch notes into our changelog today',
        {
          allowCloudChain: true,
          // 'prov/cached-b' sits at list position 1 — the pinned contract says
          // it must still be tried FIRST, deduplicated, not skipped in place.
          pinnedCloudModel: 'prov/cached-b',
          cfg: {} as any,
          cache: {
            classifier_cloud_models: ['prov/cached-a', 'prov/cached-b'],
            classifier_cloud_probe_sig: PROBE_SIGNATURE,
          } as any,
          completeSimple,
          findModel,
        }
      );

      expect(findModel.mock.calls[0]?.[0]).toBe('prov/cached-b');
      expect(completeSimple).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ category: 'standard', reason: 'from pinned', confidence: 0.9 });
    });

    it('skips an unresolvable pinned model and continues with the cached list', async () => {
      vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
      const completeSimple = vi
        .fn()
        .mockResolvedValue(
          cloudReply({ category: 'planning', reason: 'from cached', confidence: 0.8 })
        );
      const findModel = vi.fn((ref: string) => (ref === 'prov/pinned' ? undefined : mockModel));

      const result = await classifyPrompt('Prioritize the open tasks on our roadmap now', {
        allowCloudChain: true,
        pinnedCloudModel: 'prov/pinned',
        cfg: {} as any,
        cache: {
          classifier_cloud_models: ['prov/cached'],
          classifier_cloud_probe_sig: PROBE_SIGNATURE,
        } as any,
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
    // Owner decision 2026-10-03 (live over-hinting finding), follow-up merge:
    // classifyPrompt NEVER synthesizes a hint itself. The old
    // applyEscalationLogic was a second routing table that conflicted with
    // CATEGORY_TO_GROUP (its tier comparison converted nearly every
    // ordinary prompt into a hint:group:tactical → claude-bridge/claude-
    // opus-5-5 lock-in — 14/15 turns of a live session). Since the 2026-10-03
    // redesign the synthesized hint routed EXACTLY like the category path
    // (same group from CATEGORY_TO_GROUP, same fallback chains, same
    // stickiness) — pure narration — so the whole synthesis layer is gone.
    // Hints in a classification result can now only originate from an
    // explicit user HINT/MHINT in the prompt. Upgrade categories route via
    // their category alone (code_complex → tactical is pinned in
    // classifier-mapping-hints.test.ts).
    it('returns a plain code_complex classification even for a genuine upgrade category', async () => {
      vi.mocked(callOllama).mockResolvedValueOnce(
        ollamaReply({ category: 'code_complex', reason: 'complex task', confidence: 0.9 })
      );

      const result = await classifyPrompt('Design a distributed queue with retries please', {
        context: { lastModel: 'unknown/cheap-model' },
        cache: localModelCache(),
      });

      expect('hintType' in result).toBe(false);
      expect(result.category).toBe('code_complex');
    });

    it('returns a plain classification for an ordinary standard task', async () => {
      vi.mocked(callOllama).mockResolvedValueOnce(
        ollamaReply({ category: 'standard', reason: 'ordinary task', confidence: 0.9 })
      );

      const result = await classifyPrompt('Set the PR to ready please', {
        context: { lastModel: 'unknown/cheap-model' },
        cache: localModelCache(),
      });

      expect('hintType' in result).toBe(false);
      expect(result.category).toBe('standard');
    });

    it('returns a plain classification for a trivial task', async () => {
      vi.mocked(callOllama).mockResolvedValueOnce(
        ollamaReply({ category: 'simple', reason: 'trivial task', confidence: 0.9 })
      );

      const result = await classifyPrompt('Show me the todo list in this repository now', {
        context: { lastModel: 'unknown/cheap-model' },
        cache: localModelCache(),
      });

      expect('hintType' in result).toBe(false);
      expect(result.category).toBe('simple');
    });
  });

  describe('error handling', () => {
    it('degrades to the fallback category on invalid JSON from Ollama', async () => {
      vi.mocked(callOllama).mockResolvedValue('This is not JSON at all');

      const result = await classifyPrompt('Tell me how the classifier handles broken replies', {
        model: 'gemma-primary',
        fallbackModel: 'gemma-backup',
        allowCloudChain: false,
        allowStaticFallback: false,
      });

      // Both attempts return invalid JSON → both throw → fallback result.
      expect(callOllama).toHaveBeenCalledTimes(2);
      expect(result.category).toBe('continue');
    });

    it('handles an empty prompt without throwing', async () => {
      vi.mocked(callOllama).mockResolvedValueOnce(
        ollamaReply({ category: 'simple', reason: 'empty prompt', confidence: 0.8 })
      );

      const result = await classifyPrompt('', { cache: localModelCache() });

      expect(result.category).toBe('simple');
    });
  });
});

describe('classifier chain order: local first, cloud second', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isOllamaAvailable).mockResolvedValue(true);
  });

  it('a usable local answer is final: the cloud chain is never called', async () => {
    vi.mocked(callOllama).mockResolvedValueOnce(
      ollamaReply({ category: 'simple', reason: 'local answer', confidence: 0.9 })
    );
    const completeSimple = vi
      .fn()
      .mockResolvedValue(cloudReply({ category: 'design', reason: 'cloud', confidence: 0.9 }));

    const result = await classifyPrompt('Rename the local helper variable in this small file', {
      model: 'gemma-primary',
      allowCloudChain: true,
      cfg: {} as any,
      cache: {
        classifier_cloud_models: ['prov/cloud-a'],
        classifier_cloud_probe_sig: PROBE_SIGNATURE,
      } as any,
      completeSimple,
      findModel: vi.fn().mockReturnValue(mockModel),
    });

    expect(callOllama).toHaveBeenCalledTimes(1);
    expect(completeSimple).not.toHaveBeenCalled();
    expect(result).toEqual({ category: 'simple', reason: 'local answer', confidence: 0.9 });
  });

  it('when the local leg fails, the cloud chain answers', async () => {
    vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
    const completeSimple = vi
      .fn()
      .mockResolvedValue(
        cloudReply({ category: 'code_simple', reason: 'cloud', confidence: 0.85 })
      );

    const result = await classifyPrompt('Add a missing semicolon at the end of that statement', {
      model: 'gemma-primary',
      allowCloudChain: true,
      cfg: {} as any,
      cache: {
        classifier_cloud_models: ['prov/cloud-a'],
        classifier_cloud_probe_sig: PROBE_SIGNATURE,
      } as any,
      completeSimple,
      findModel: vi.fn().mockReturnValue(mockModel),
    });

    expect(callOllama).toHaveBeenCalled();
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ category: 'code_simple', reason: 'cloud', confidence: 0.85 });
  });

  it('with the daemon unreachable, the cloud chain answers without any local call', async () => {
    vi.mocked(isOllamaAvailable).mockResolvedValue(false);
    const completeSimple = vi
      .fn()
      .mockResolvedValue(
        cloudReply({ category: 'standard', reason: 'cloud only', confidence: 0.8 })
      );

    const result = await classifyPrompt('Summarise the trade-offs of the two caching strategies', {
      model: 'gemma-primary',
      allowCloudChain: true,
      cfg: {} as any,
      cache: {
        classifier_cloud_models: ['prov/cloud-a'],
        classifier_cloud_probe_sig: PROBE_SIGNATURE,
      } as any,
      completeSimple,
      findModel: vi.fn().mockReturnValue(mockModel),
    });

    expect(callOllama).not.toHaveBeenCalled();
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ category: 'standard', reason: 'cloud only', confidence: 0.8 });
  });

  it('without the cloud chain enabled, the local answer is used and no cloud is tried', async () => {
    vi.mocked(callOllama).mockRejectedValue(new Error('ECONNREFUSED'));
    const completeSimple = vi.fn();

    await classifyPrompt('Explain the difference between a mutex and a semaphore briefly', {
      model: 'gemma-primary',
      allowCloudChain: false,
      cfg: {} as any,
      cache: {} as any,
      completeSimple,
      findModel: vi.fn().mockReturnValue(mockModel),
    });

    expect(completeSimple).not.toHaveBeenCalled();
  });
});

describe('low-confidence escalation to the cloud chain (opt-in)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isOllamaAvailable).mockResolvedValue(true);
  });

  const lowLocal = () =>
    ollamaReply({ category: 'design', reason: 'unsure local', confidence: 0.3 });
  const cloudCache = {
    classifier_cloud_models: ['prov/cloud-a'],
    classifier_cloud_probe_sig: PROBE_SIGNATURE,
  } as any;

  it('default (off): a low-confidence local reply is final and the cloud is not asked', async () => {
    vi.mocked(callOllama).mockResolvedValueOnce(lowLocal());
    const completeSimple = vi
      .fn()
      .mockResolvedValue(cloudReply({ category: 'planning', reason: 'cloud', confidence: 0.95 }));

    const result = await classifyPrompt('Weigh two sharding strategies for the event store', {
      model: 'gemma-primary',
      allowCloudChain: true,
      cfg: {} as any,
      cache: cloudCache,
      completeSimple,
      findModel: vi.fn().mockReturnValue(mockModel),
    });

    expect(completeSimple).not.toHaveBeenCalled();
    expect(result.confidence).toBe(0.3);
  });

  it('on: a low-confidence local reply is escalated and the cloud answer is used', async () => {
    vi.mocked(callOllama).mockResolvedValueOnce(lowLocal());
    const completeSimple = vi
      .fn()
      .mockResolvedValue(cloudReply({ category: 'planning', reason: 'cloud', confidence: 0.95 }));

    const result = await classifyPrompt('Compare two replication topologies for the ledger', {
      model: 'gemma-primary',
      allowCloudChain: true,
      escalateLowConfidence: true,
      cfg: {} as any,
      cache: cloudCache,
      completeSimple,
      findModel: vi.fn().mockReturnValue(mockModel),
    });

    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ category: 'planning', reason: 'cloud', confidence: 0.95 });
  });

  it('on: a confident local reply is final, the cloud is not asked', async () => {
    vi.mocked(callOllama).mockResolvedValueOnce(
      ollamaReply({ category: 'simple', reason: 'sure local', confidence: 0.9 })
    );
    const completeSimple = vi.fn();

    const result = await classifyPrompt('Rename the counter variable in the loop body', {
      model: 'gemma-primary',
      allowCloudChain: true,
      escalateLowConfidence: true,
      cfg: {} as any,
      cache: cloudCache,
      completeSimple,
      findModel: vi.fn().mockReturnValue(mockModel),
    });

    expect(completeSimple).not.toHaveBeenCalled();
    expect(result).toEqual({ category: 'simple', reason: 'sure local', confidence: 0.9 });
  });

  it('on, but the cloud fails: the gated local answer is kept', async () => {
    vi.mocked(callOllama).mockResolvedValueOnce(lowLocal());
    const completeSimple = vi
      .fn()
      .mockResolvedValue({ errorMessage: 'provider 500', stopReason: 'error' });

    const result = await classifyPrompt('Draft a retry policy for the outbound webhook queue', {
      model: 'gemma-primary',
      allowCloudChain: true,
      escalateLowConfidence: true,
      cfg: {} as any,
      cache: cloudCache,
      completeSimple,
      findModel: vi.fn().mockReturnValue(mockModel),
    });

    expect(completeSimple).toHaveBeenCalled();
    expect(result.confidence).toBe(0.3);
  });

  it('on, but the cloud chain is off: nothing is escalated', async () => {
    vi.mocked(callOllama).mockResolvedValueOnce(lowLocal());
    const completeSimple = vi.fn();

    await classifyPrompt('Explain the trade-off between leases and fencing tokens', {
      model: 'gemma-primary',
      allowCloudChain: false,
      escalateLowConfidence: true,
      cfg: {} as any,
      cache: cloudCache,
      completeSimple,
      findModel: vi.fn().mockReturnValue(mockModel),
    });

    expect(completeSimple).not.toHaveBeenCalled();
  });
});

describe('user-configured cloud candidates (classifier_cloud_candidates)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isOllamaAvailable).mockResolvedValue(false);
  });

  it('when set, the list replaces the probe-verified list and is tried in its order', async () => {
    const completeSimple = vi
      .fn()
      .mockResolvedValue(cloudReply({ category: 'standard', reason: 'mine', confidence: 0.9 }));
    const findModel = vi.fn().mockReturnValue(mockModel);

    const result = await classifyPrompt('Pick the cheapest acceptable model for this chore', {
      allowCloudChain: true,
      cloudCandidates: ['prov/mine-a', 'prov/mine-b'],
      cfg: {} as any,
      cache: {
        classifier_cloud_models: ['prov/probed-only'],
        classifier_cloud_probe_sig: PROBE_SIGNATURE,
      } as any,
      completeSimple,
      findModel,
    });

    expect(findModel.mock.calls.map((c) => c[0])).toEqual(['prov/mine-a']);
    expect(findModel).not.toHaveBeenCalledWith('prov/probed-only');
    expect(result).toEqual({ category: 'standard', reason: 'mine', confidence: 0.9 });
  });

  it('the pinned cloud model stays first, then the configured list', async () => {
    const completeSimple = vi
      .fn()
      .mockResolvedValue(cloudReply({ category: 'simple', reason: 'pinned', confidence: 0.9 }));
    const findModel = vi.fn().mockReturnValue(mockModel);

    await classifyPrompt('Rename the local variable in this tiny function body', {
      allowCloudChain: true,
      pinnedCloudModel: 'prov/pinned',
      cloudCandidates: ['prov/mine-a'],
      cfg: {} as any,
      cache: {} as any,
      completeSimple,
      findModel,
    });

    expect(findModel.mock.calls.map((c) => c[0])).toEqual(['prov/pinned']);
  });
});
