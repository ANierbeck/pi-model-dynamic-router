// Bug report 2026-10-06: a user with no openrouter key still had the
// classifier's cloud fallback chain call completeSimple for every
// openrouter/* candidate, and every single call failed with "Provider is
// not configured: openrouter" — 8 dead requests per classification,
// forever, with no clear skip reason. Root cause: findModel() resolving a
// ref to a pi Model object only proves pi's builtin catalog KNOWS the
// model's shape, not that the provider has credentials — a provider
// without a key still resolves via findModel and fails one level deeper,
// inside completeSimple.
//
// Fix: when the new optional hasConfiguredAuth hook is provided, a
// resolved candidate whose provider has no configured auth is skipped
// BEFORE completeSimple is ever called, with a distinct log reason.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isOllamaAvailable } from '../src/ollama-utils.ts';
import { classifyPrompt } from '../src/content-classifier.ts';

vi.mock('../src/ollama-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ollama-utils.ts')>();
  return { ...actual, callOllama: vi.fn(), isOllamaAvailable: vi.fn() };
});

const mockModel = { id: 'some-model', provider: 'openrouter' };
const cloudReply = (r: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(r) }],
  stopReason: 'stop',
});

describe('classifyPrompt cloud fallback: unconfigured provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isOllamaAvailable).mockResolvedValue(false);
  });

  it('skips a candidate whose provider has no configured auth WITHOUT calling completeSimple', async () => {
    const completeSimple = vi.fn().mockResolvedValue(
      cloudReply({ category: 'simple', reason: 'should never be reached', confidence: 0.9 })
    );
    const findModel = vi.fn().mockReturnValue(mockModel);
    const hasConfiguredAuth = vi.fn().mockReturnValue(false);

    const result = await classifyPrompt('Unconfigured provider candidate must be skipped, not tried', {
      allowCloudFallback: true,
      allowStaticFallback: true,
      cfg: {} as any,
      cache: {
        classifier_fallback_models: ['openrouter/free-model-a'],
      } as any,
      completeSimple,
      findModel,
      hasConfiguredAuth,
      cloudTimeoutMs: 50,
    });

    expect(hasConfiguredAuth).toHaveBeenCalledWith(mockModel);
    expect(completeSimple).not.toHaveBeenCalled();
    // Degrades to static fallback instead of hanging/throwing.
    expect(result.category).toBeTruthy();
  });

  it('still tries a candidate when hasConfiguredAuth returns true (regression guard)', async () => {
    const completeSimple = vi.fn().mockResolvedValue(
      cloudReply({ category: 'simple', reason: 'configured provider answered', confidence: 0.9 })
    );
    const findModel = vi.fn().mockReturnValue(mockModel);
    const hasConfiguredAuth = vi.fn().mockReturnValue(true);

    const result = await classifyPrompt('Configured provider candidate must still be tried', {
      allowCloudFallback: true,
      cfg: {} as any,
      cache: {
        classifier_fallback_models: ['openrouter/free-model-a'],
      } as any,
      completeSimple,
      findModel,
      hasConfiguredAuth,
      cloudTimeoutMs: 50,
    });

    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ category: 'simple', reason: 'configured provider answered', confidence: 0.9 });
  });

  it('without the hasConfiguredAuth hook, behavior is unchanged (optional, fail-open)', async () => {
    const completeSimple = vi.fn().mockResolvedValue(
      cloudReply({ category: 'simple', reason: 'no hook provided', confidence: 0.9 })
    );
    const findModel = vi.fn().mockReturnValue(mockModel);

    const result = await classifyPrompt('No hasConfiguredAuth hook provided at all', {
      allowCloudFallback: true,
      cfg: {} as any,
      cache: {
        classifier_fallback_models: ['openrouter/free-model-a'],
      } as any,
      completeSimple,
      findModel,
      cloudTimeoutMs: 50,
    });

    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ category: 'simple', reason: 'no hook provided', confidence: 0.9 });
  });
});
