// test/model-matcher.test.ts
// Unit-Tests for the LLM-assisted model → GDPval matching.
//
// These tests cover the PURE parts of the matching pipeline:
//   - parseMatchResponse: validates + constrains the LLM output to known slugs
//
// The LLM call itself (matchModelsWithLLMBatched) is tested separately in
// test/model-matcher-batched.test.ts with an injectable caller so no network
// is required.
//
// NOTE (A2): this file used to also test resolveModelScores, a second GDPval
// score-resolution pipeline that lived in src/model-matcher.ts but was dead
// code (never called from index.ts) and had drifted from the real production
// pipeline (src/metrics.ts resolveSlug/lookupGdp). Removed together with the
// dead code; see test/model-map-live.test.ts for the equivalent live
// model-map.yaml regression guard, now exercised against the real pipeline.

import { describe, it, expect } from 'vitest';
import {
  parseMatchResponse,
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

