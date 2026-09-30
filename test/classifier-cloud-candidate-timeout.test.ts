// Final v1.6.0 review finding S3 (Important): the RUNTIME cloud fallback
// chain (content-classifier.ts tryCloud loop) called completeSimple with
// NO per-candidate timeout — unlike the scan-time probe, which caps every
// candidate at PROBE_TIMEOUT_MS. A hung cloud request (connection opened,
// response never arriving) stalled the entire classification and with it
// the turn, and the chain never advanced to the next candidate. This test
// pins the per-candidate timeout: a hanging first candidate is abandoned
// after cloudTimeoutMs and the SECOND candidate answers.
//
// TDD: proven red pre-fix — without a timeout the first completeSimple
// promise never settles and this test fails on the vitest testTimeout
// (the hang IS the bug).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callOllama, isOllamaAvailable } from '../src/ollama-utils.ts';
import { classifyPrompt } from '../src/content-classifier.ts';

vi.mock('../src/ollama-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ollama-utils.ts')>();
  return { ...actual, callOllama: vi.fn(), isOllamaAvailable: vi.fn() };
});

const mockModel = { id: 'test-model', provider: 'prov' };
const cloudReply = (r: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(r) }],
  stopReason: 'stop',
});

describe('classifyPrompt cloud fallback: per-candidate timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isOllamaAvailable).mockResolvedValue(false);
  });

  it('abandons a hanging cloud candidate and succeeds with the next one', async () => {
    // First candidate NEVER settles (the S3 hang); second answers normally.
    const completeSimple = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {})) // hangs forever
      .mockImplementationOnce(() =>
        Promise.resolve(
          cloudReply({ category: 'simple', reason: 'from second cloud candidate', confidence: 0.9 })
        )
      );
    const findModel = vi.fn().mockReturnValue(mockModel);

    const result = await classifyPrompt('Hanging cloud candidate must not stall classification', {
      allowCloudFallback: true,
      cfg: {} as any,
      cache: {
        classifier_fallback_models: ['prov/hang-model', 'prov/good-model'],
      } as any,
      completeSimple,
      findModel,
      // Small timeout so the regression test runs fast; the default is
      // CLASSIFIER_CLOUD_TIMEOUT_MS (15s, probe parity).
      cloudTimeoutMs: 50,
    });

    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ category: 'simple', reason: 'from second cloud candidate', confidence: 0.9 });
  });

  it('falls through cleanly when EVERY cloud candidate hangs', async () => {
    const completeSimple = vi.fn().mockImplementation(() => new Promise(() => {}));
    const findModel = vi.fn().mockReturnValue(mockModel);

    // allowStaticFallback keeps the promise from never resolving at all —
    // the chain must degrade, not hang. Static classification answers.
    const result = await classifyPrompt('All hanging cloud candidates must degrade to static', {
      allowCloudFallback: true,
      allowStaticFallback: true,
      cfg: {} as any,
      cache: {
        classifier_fallback_models: ['prov/hang-a', 'prov/hang-b'],
      } as any,
      completeSimple,
      findModel,
      cloudTimeoutMs: 50,
    });

    expect(completeSimple).toHaveBeenCalledTimes(2);
    // Static fallback: a routed fallback category, never a hang/throw.
    expect(result.category).toBeTruthy();
  });
});
