/**
 * Regression tests for HINT target normalization (2026-09-20 incident:
 * "warum funktioniert mein hint nicht mehr?").
 *
 * The user issued "HINT: zai-glm-5.3" and "HINT: zai-glm-5_3" — the model
 * exists in Pi's registry as `zai-glm-5-3` (dash). All three hint-resolution
 * matching steps (`namesMatch` in stream-orchestrator.ts,
 * `modelRegistry.find()`, `resolveShortModelName` in utils.ts) compared
 * strings EXACTLY, so no separator variant ever matched and the router
 * logged `HINT model "zai-glm-5.3" not found; using as-is` — then fell
 * through to the fallback group, which the mistral-zai ghost with its fake
 * $0.0 cost won, breaking the turn.
 *
 * The fix: exact match stays first priority, but every matching step gets a
 * second-chance comparison with normalized separators (dots/underscores →
 * dashes, case-insensitive) on BOTH sides — so registry ids containing dots
 * (e.g. `mistral-medium-3.5`) keep matching exactly, while separator
 * variants of the same name resolve to the same model.
 */
import { describe, it, expect } from 'vitest';
import { resolveShortModelName, hintTargetMatches, normalizeHintName } from '../src/utils.ts';

const POOL = ['mistral/zai-glm-5-3', 'mistral/mistral-medium-3.5', 'openrouter/z-ai/glm-5.2'];

describe('normalizeHintName', () => {
  it('maps dots and underscores to dashes, case-insensitively', () => {
    expect(normalizeHintName('zai-glm-5.3')).toBe('zai-glm-5-3');
    expect(normalizeHintName('zai-glm-5_3')).toBe('zai-glm-5-3');
    expect(normalizeHintName('ZAI-GLM-5.3')).toBe('zai-glm-5-3');
  });

  it('is idempotent for already-normalized names', () => {
    expect(normalizeHintName('zai-glm-5-3')).toBe('zai-glm-5-3');
    expect(normalizeHintName('mistral-medium-3.5')).toBe('mistral-medium-3-5');
  });
});

describe('resolveShortModelName with separator normalization', () => {
  it('exact match still wins and is returned as-is', () => {
    expect(resolveShortModelName('zai-glm-5-3', POOL)).toBe('mistral/zai-glm-5-3');
  });

  it('resolves the dot variant (zai-glm-5.3)', () => {
    expect(resolveShortModelName('zai-glm-5.3', POOL)).toBe('mistral/zai-glm-5-3');
  });

  it('resolves the underscore variant (zai-glm-5_3)', () => {
    expect(resolveShortModelName('zai-glm-5_3', POOL)).toBe('mistral/zai-glm-5-3');
  });

  it('resolves the case-insensitive variant', () => {
    expect(resolveShortModelName('ZAI-GLM-5.3', POOL)).toBe('mistral/zai-glm-5-3');
  });

  it('resolves registry ids that themselves contain a dot (mistral-medium-3.5)', () => {
    expect(resolveShortModelName('mistral-medium-3.5', POOL)).toBe('mistral/mistral-medium-3.5');
    expect(resolveShortModelName('mistral-medium-3-5', POOL)).toBe('mistral/mistral-medium-3.5');
  });

  it('returns null when nothing matches', () => {
    expect(resolveShortModelName('gpt-9', POOL)).toBeNull();
  });

  it('passes through refs containing a slash untouched', () => {
    expect(resolveShortModelName('mistral/zai-glm-5-3', POOL)).toBe('mistral/zai-glm-5-3');
  });
});

describe('hintTargetMatches', () => {
  it('matches a bare model id exactly', () => {
    expect(hintTargetMatches('zai-glm-5-3', 'mistral/zai-glm-5-3')).toBe(true);
  });

  it('matches separator variants (dot, underscore, case)', () => {
    expect(hintTargetMatches('zai-glm-5.3', 'mistral/zai-glm-5-3')).toBe(true);
    expect(hintTargetMatches('zai-glm-5_3', 'mistral/zai-glm-5-3')).toBe(true);
    expect(hintTargetMatches('ZAI_GLM_5.3', 'mistral/zai-glm-5-3')).toBe(true);
  });

  it('does not match unrelated models', () => {
    expect(hintTargetMatches('zai-glm-5-3', 'mistral/mistral-medium-3.5')).toBe(false);
    expect(hintTargetMatches('zai-glm-5-2', 'mistral/zai-glm-5-3')).toBe(false);
  });
});
