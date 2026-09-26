/**
 * Regression tests for the model-hint marker collision (2026-09-20).
 * Plain HINT: parsing is covered in hint-classification.test.ts.
 *
 * The user's reserved channel to the router is "HINT:" — but the router's
 * OWN model narration used the same literal ("HINT: <model>"), so quoted
 * narration could be re-read as a fresh user instruction (the 2026-09-18
 * lock-in loop) and any prose mentioning "HINT:" risked hijacking the turn.
 *
 * The fix: the router's own model-hint marker becomes "MHINT" (also
 * accepted/recognized: "Model-HINT" / "Model_HINT"). `HINT:` remains the
 * user's channel with unchanged semantics (model OR group hints).
 * MHINT-variants are MODEL hints by definition.
 */
import { describe, it, expect } from 'vitest';
import { detectHintDirectly } from '../src/content-classifier.ts';

describe('detectHintDirectly: MHINT markers are model hints', () => {
  it('recognizes "MHINT: <model>"', () => {
    const r = detectHintDirectly('MHINT: zai-glm-5-3');
    expect(r?.hintType).toBe('model');
    expect(r?.hintTarget).toBe('zai-glm-5-3');
  });

  it('recognizes "Model-HINT: <model>" and "Model_HINT: <model>"', () => {
    expect(detectHintDirectly('Model-HINT: zai-glm-5-3')?.hintType).toBe('model');
    expect(detectHintDirectly('MODEL_HINT: zai-glm-5-3')?.hintTarget).toBe('zai-glm-5-3');
  });

  it('is case-insensitive', () => {
    const r = detectHintDirectly('mhint: zai-glm-5-3');
    expect(r?.hintType).toBe('model');
    expect(r?.hintTarget).toBe('zai-glm-5-3');
  });

  it('supports the verb form after MHINT', () => {
    const r = detectHintDirectly('MHINT: use mistral-medium-3.5');
    expect(r?.hintType).toBe('model');
    expect(r?.hintTarget).toBe('mistral-medium-3.5');
  });

  it('does not treat MHINT text as a group hint', () => {
    // MHINT is model-only by definition: even a "group" word after it is
    // taken as a literal model name, never routed to the group branch.
    const r = detectHintDirectly('MHINT: tactical');
    expect(r?.hintType).toBe('model');
    expect(r?.hintTarget).toBe('tactical');
    // A group verb after MHINT falls through to the LLM classifier (null):
    // literal extraction would otherwise target "use".
    expect(detectHintDirectly('MHINT: use group tactical')).toBeNull();
  });
});
