// test/model-matcher.test.ts
// Unit-Tests for the LLM-assisted model → GDPval matching.
//
// These tests cover the PURE parts of the matching pipeline:
//   - parseMatchResponse: validates + constrains the LLM output to known slugs
//   - resolveModelScores: merges model-map → token-fallback → LLM matches into
//                         a final { modelRef → score | null } map
//
// The LLM call itself (matchModelsWithLLMBatched) is tested separately in
// test/model-matcher-batched.test.ts with an injectable caller so no network
// is required.

import { describe, it, expect } from 'vitest';
import {
  parseMatchResponse,
  resolveModelScores,
  type GdpvalEntry,
} from '../src/model-matcher.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const GDPVAL: GdpvalEntry[] = [
  { slug: 'glm-5-2', label: 'GLM 5.2', score: 1511.72 },
  { slug: 'mistral-medium-3-5', label: 'Mistral Medium 3.5', score: 924.55 },
  { slug: 'claude-sonnet-5', label: 'Claude Sonnet 5', score: 1603 },
  { slug: 'gpt-5-5', label: 'GPT 5.5', score: 1485.48 },
  { slug: 'qwen3-7-max', label: 'Qwen3 7 Max', score: 1279.77 },
];

const VALID_SLUGS = new Set(GDPVAL.map((g) => g.slug));

// A small model-map (authoritative): modelId → slug | null (null = excluded)
const MODEL_MAP: Record<string, string | null> = {
  'claude-sonnet-4-5-*': 'claude-sonnet-5', // wildcard alias
  'zai-org/GLM-5-Turbo': null, // explicitly excluded
};

// ── parseMatchResponse ────────────────────────────────────────────────────

describe('parseMatchResponse', () => {
  it('parses a clean JSON mapping and keeps only valid slugs', () => {
    const raw = JSON.stringify({
      'zai-glm-5-2': 'glm-5-2',
      'mistral/glm-5-2': 'glm-5-2',
    });
    const result = parseMatchResponse(raw, VALID_SLUGS);
    expect(result).toEqual({
      'zai-glm-5-2': 'glm-5-2',
      'mistral/glm-5-2': 'glm-5-2',
    });
  });

  it('drops matches to slugs that do not exist in gdpval_scores (hallucination guard)', () => {
    const raw = JSON.stringify({
      'zai-glm-5-2': 'glm-5-2',
      'shady-model': 'totally-fabricated-slug',
    });
    const result = parseMatchResponse(raw, VALID_SLUGS);
    expect(result['zai-glm-5-2']).toBe('glm-5-2');
    expect(result['shady-model']).toBeUndefined();
  });

  it('strips markdown code fences wrapping the JSON', () => {
    const raw = '```json\n{"zai-glm-5-2": "glm-5-2"}\n```';
    const result = parseMatchResponse(raw, VALID_SLUGS);
    expect(result).toEqual({ 'zai-glm-5-2': 'glm-5-2' });
  });

  it('extracts the first JSON object when the LLM adds prose around it', () => {
    const raw = 'Here are the matches:\n{"zai-glm-5-2": "glm-5-2"}\nDone.';
    const result = parseMatchResponse(raw, VALID_SLUGS);
    expect(result).toEqual({ 'zai-glm-5-2': 'glm-5-2' });
  });

  it('returns an empty map for unparseable input (fails safe, not throws)', () => {
    expect(parseMatchResponse('not json at all', VALID_SLUGS)).toEqual({});
    expect(parseMatchResponse('', VALID_SLUGS)).toEqual({});
    expect(parseMatchResponse('```', VALID_SLUGS)).toEqual({});
  });

  it('ignores null / non-string values in the mapping', () => {
    const raw = JSON.stringify({
      'zai-glm-5-2': 'glm-5-2',
      'bad-entry': null,
      'another-bad': 42,
    });
    const result = parseMatchResponse(raw, VALID_SLUGS);
    expect(Object.keys(result)).toEqual(['zai-glm-5-2']);
  });

  it('ignores entries whose key was not part of the request (extra models the LLM invented)', () => {
    // Note: parseMatchResponse cannot know which models were requested, but it
    // MUST reject unknown slugs. The caller filters by requested ids afterward.
    const raw = JSON.stringify({
      'zai-glm-5-2': 'glm-5-2',
      'invented-model': 'glm-5-2', // invented key but valid slug → kept; caller filters
    });
    const result = parseMatchResponse(raw, VALID_SLUGS);
    expect(result['zai-glm-5-2']).toBe('glm-5-2');
    // 'invented-model' maps to a valid slug so it stays; the orchestrator
    // intersects with the requested model list before use.
    expect(result['invented-model']).toBe('glm-5-2');
  });
});

// ── resolveModelScores (the merge pipeline) ────────────────────────────────

describe('resolveModelScores', () => {
  const gdpvalScores: Record<string, number> = Object.fromEntries(
    GDPVAL.map((g) => [g.slug, g.score])
  );

  it('uses model-map.yaml exact mapping first (authoritative)', () => {
    // 'zai-glm-5-2' is NOT in the map, so it should fall through. But a model
    // that IS mapped should resolve via the map without needing the LLM.
    const refs = ['claude-sonnet-4-5-20250929'];
    const result = resolveModelScores({
      modelRefs: refs,
      gdpvalScores,
      modelMap: MODEL_MAP,
      modelMapWildcards: [['claude-sonnet-4-5-', 'claude-sonnet-5']],
      llmMatches: {},
    });
    expect(result['claude-sonnet-4-5-20250929']).toBe(1603);
  });

  it('honours explicit null (exclusion) in model-map → null score', () => {
    const result = resolveModelScores({
      modelRefs: ['zai-org/GLM-5-Turbo'],
      gdpvalScores,
      modelMap: MODEL_MAP,
      modelMapWildcards: [],
      llmMatches: {},
    });
    expect(result['zai-org/GLM-5-Turbo']).toBeNull();
  });

  it('falls back to token-set matching when no map entry', () => {
    // 'glm-5-2' (after provider strip) matches the slug token set directly
    const result = resolveModelScores({
      modelRefs: ['mistral/glm-5-2'],
      gdpvalScores,
      modelMap: {},
      modelMapWildcards: [],
      llmMatches: {},
    });
    expect(result['mistral/glm-5-2']).toBe(1511.72);
  });

  it('uses LLM matches when both map and token fallback miss (the GLM bug fix)', () => {
    // 'zai-glm-5-2' has token set {zai,glm,5,2} which does NOT equal {glm,5,2}
    // → token fallback fails. The LLM match saves it.
    const result = resolveModelScores({
      modelRefs: ['mistral-zai/zai-glm-5-2'],
      gdpvalScores,
      modelMap: {},
      modelMapWildcards: [],
      llmMatches: { 'mistral-zai/zai-glm-5-2': 'glm-5-2' },
    });
    expect(result['mistral-zai/zai-glm-5-2']).toBe(1511.72);
  });

  it('returns null when all three layers miss (truly unknown model)', () => {
    const result = resolveModelScores({
      modelRefs: ['completely-unknown-model-xyz'],
      gdpvalScores,
      modelMap: {},
      modelMapWildcards: [],
      llmMatches: {},
    });
    expect(result['completely-unknown-model-xyz']).toBeNull();
  });

  it('precedence: model-map beats LLM match (map is authoritative)', () => {
    // Map says excluded (null); LLM says glm-5-2. Map wins → null.
    const result = resolveModelScores({
      modelRefs: ['zai-org/GLM-5-Turbo'],
      gdpvalScores,
      modelMap: MODEL_MAP,
      modelMapWildcards: [],
      llmMatches: { 'zai-org/GLM-5-Turbo': 'glm-5-2' },
    });
    expect(result['zai-org/GLM-5-Turbo']).toBeNull();
  });

  it('precedence: token-fallback beats LLM (cheaper, deterministic)', () => {
    // Token fallback would match 'glm-5-2' directly; LLM shouldn't override.
    const result = resolveModelScores({
      modelRefs: ['mistral/glm-5-2'],
      gdpvalScores,
      modelMap: {},
      modelMapWildcards: [],
      llmMatches: { 'mistral/glm-5-2': 'gpt-5-5' }, // wrong, must be ignored
    });
    expect(result['mistral/glm-5-2']).toBe(1511.72); // token-fallback wins
  });

  it('handles multiple refs in one call', () => {
    const refs = [
      'mistral-zai/zai-glm-5-2',
      'mistral/glm-5-2',
      'zai-org/GLM-5-Turbo', // excluded via map
      'claude-sonnet-4-5-20250929', // wildcard map
      'unknown-thing',
    ];
    const result = resolveModelScores({
      modelRefs: refs,
      gdpvalScores,
      modelMap: MODEL_MAP,
      modelMapWildcards: [['claude-sonnet-4-5-', 'claude-sonnet-5']],
      llmMatches: { 'mistral-zai/zai-glm-5-2': 'glm-5-2' },
    });
    expect(result['mistral-zai/zai-glm-5-2']).toBe(1511.72);
    expect(result['mistral/glm-5-2']).toBe(1511.72);
    expect(result['zai-org/GLM-5-Turbo']).toBeNull();
    expect(result['claude-sonnet-4-5-20250929']).toBe(1603);
    expect(result['unknown-thing']).toBeNull();
  });

  it('returns empty object for empty input', () => {
    const result = resolveModelScores({
      modelRefs: [],
      gdpvalScores,
      modelMap: {},
      modelMapWildcards: [],
      llmMatches: {},
    });
    expect(result).toEqual({});
  });
});
