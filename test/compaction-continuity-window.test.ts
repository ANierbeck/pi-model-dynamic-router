// test/compaction-continuity-window.test.ts
// docs/plans/2026-11-07-compaction-continuity.md (TODO I5).
//
// Compaction continuity used to decide "is the last model large enough to
// continue in" from a hardcoded regex over the ref (isSmallLocal, matching
// /ollama\/|lm-studio\// and small-parameter-count names). A 200k-window cloud
// model named "qwen3-4b" was refused continuity even though its window dwarfs
// the compacted context, and a 4k-window model named "granite-instant" was
// allowed continuity and re-overflowed on the next turn.
//
// The decision now reads the model's REAL context window
// (context.lastModelContextWindow, wired by the orchestrator from
// getModelContextWindow) against the estimated compacted context
// (context.contextTokens) through the SAME reserve-aware budget the
// driveStream pre-flight guard uses (planOutputBudget). Unknown window =
// not large enough (fail-closed). Free-tier refs (`:free`, free_models,
// local providers) and meta-router refs (openrouter/openrouter/…) never get
// the compaction hint: they must not be asked to hold the one context the
// router must not lose.

import { describe, it, expect } from 'vitest';
import { classifyPrompt } from '../src/content-classifier.ts';

const COMPACT_PROMPT = 'please continue the refactor';
/** Token estimate of the compacted context the fixtures describe. */
const COMPACTED_TOKENS = 20_000;

function compactionContext(overrides: Record<string, unknown> = {}) {
  return {
    isCompaction: true,
    lastModelLimited: false,
    contextTokens: COMPACTED_TOKENS,
    ...overrides,
  };
}

async function classify(context: Record<string, unknown>) {
  return classifyPrompt(COMPACT_PROMPT, { context });
}

describe('compaction continuity by real context window', () => {
  it('hints back to a big-window model even when the id looks small', async () => {
    const r = await classify(
      compactionContext({
        lastModel: 'mistral/qwen3-4b',
        lastModelContextWindow: 200_000,
      })
    );
    expect(r).toMatchObject({
      hintType: 'model',
      hintTarget: 'mistral/qwen3-4b',
      origin: 'auto',
    });
  });

  it('refuses continuity when the window is unknown (fail-closed)', async () => {
    const r = await classify(
      compactionContext({ lastModel: 'mistral/unknown-window', lastModelContextWindow: null })
    );
    expect('hintType' in r).toBe(false);
    expect(r).toMatchObject({ category: 'code_complex' });
  });

  it('refuses continuity when the real window is too small for the compacted context', async () => {
    const r = await classify(
      compactionContext({ lastModel: 'mistral/granite-instant', lastModelContextWindow: 4_096 })
    );
    expect('hintType' in r).toBe(false);
    expect(r).toMatchObject({ category: 'code_complex' });
  });

  it('refuses continuity for a :free ref even with a big window', async () => {
    const r = await classify(
      compactionContext({
        lastModel: 'openrouter/meta-llama/llama-4-70b:free',
        lastModelContextWindow: 128_000,
      })
    );
    expect('hintType' in r).toBe(false);
    expect(r).toMatchObject({ category: 'code_complex' });
  });

  it('refuses continuity for a meta-router ref even with a big window', async () => {
    const r = await classify(
      compactionContext({
        lastModel: 'openrouter/openrouter/free',
        lastModelContextWindow: 128_000,
      })
    );
    expect('hintType' in r).toBe(false);
    expect(r).toMatchObject({ category: 'code_complex' });
  });

  it('still hints back to a big-window model without a parameter token (pin)', async () => {
    const r = await classify(
      compactionContext({
        lastModel: 'mistral/zai-glm-5-3',
        lastModelContextWindow: 1_000_000,
      })
    );
    expect(r).toMatchObject({ hintType: 'model', hintTarget: 'mistral/zai-glm-5-3' });
  });

  it('still refuses a last model in cooldown (pin)', async () => {
    const r = await classify(
      compactionContext({
        lastModel: 'mistral/zai-glm-5-3',
        lastModelContextWindow: 1_000_000,
        lastModelLimited: true,
      })
    );
    expect('hintType' in r).toBe(false);
    expect(r).toMatchObject({ category: 'code_complex' });
  });

  it('lets the reserve decide the boundary: window that only fits input is refused', async () => {
    // planOutputBudget reserves safety tokens + a minimum output below the
    // window; a window of exactly the input estimate cannot fit output.
    const r = await classify(
      compactionContext({
        lastModel: 'mistral/boundary-model',
        lastModelContextWindow: COMPACTED_TOKENS,
      })
    );
    expect('hintType' in r).toBe(false);
    expect(r).toMatchObject({ category: 'code_complex' });
  });
});
