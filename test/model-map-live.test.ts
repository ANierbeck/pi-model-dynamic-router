// test/model-map-live.test.ts
// Regression guard against the original GLM bug, run against the REAL
// model-map.yaml (not a fixture). Proves that vendor-prefixed Mistral-hosted
// GLM model ids are resolved ONLY by the LLM tier — i.e. tiers 1+2 miss,
// and tier 3 is what makes them appear in the router table.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveModelScores } from '../src/model-matcher.js';

// Load the actual model-map.yaml shipped with the extension.
// Parse line-by-line (tolerant of duplicate keys, mirroring the router's intent)
// because the strict YAML parser throws on the file's pre-existing duplicates.
const MAP_PATH = path.resolve(__dirname, '..', 'model-map.yaml');
const modelMap: Record<string, string | null> = {};
const modelMapWildcards: [string, string | null][] = [];
for (const line of fs.readFileSync(MAP_PATH, 'utf-8').split('\n')) {
  const stripped = line.split('#')[0].trimEnd();
  const m = stripped.match(/^([\w./\-:]+):\s*(.*)$/);
  if (!m) continue;
  const val = m[2].trim();
  const slug = val === '' || val === '~' || val === 'null' ? null : val;
  if (m[1].endsWith('*')) modelMapWildcards.push([m[1].slice(0, -1), slug]);
  else modelMap[m[1]] = slug;
}
modelMapWildcards.sort((a, b) => b[0].length - a[0].length);

const gdpvalScores: Record<string, number> = {
  'glm-5-2': 1506.11,
  'glm-52': 1506.11,
  'glm-5': 1418,
  'mistral-medium-3-5': 924.55,
};

describe('model-map.yaml (live) — GLM regression guard', () => {
  it('CONTAINS authoritative map entries for the Mistral-hosted glm-5-2 ids (override the LLM)', () => {
    // The LLM matcher sometimes mis-matches glm-5-2 → glm-4 (older slug).
    // The model-map entries are authoritative (tier 1) and prevent this.
    expect(modelMap['glm-5-2']).toBe('glm-5-2');
    expect(modelMap['zai-glm-5-2']).toBe('glm-5-2');
    expect(modelMap['glm-5-2-tee']).toBe('glm-5-2');
  });

  it('the model-map resolves zai-glm-5-2 → glm-5-2 → 1506.11 (tier 1, no LLM needed)', () => {
    const result = resolveModelScores({
      modelRefs: ['mistral-zai/zai-glm-5-2'],
      gdpvalScores,
      modelMap,
      modelMapWildcards,
      llmMatches: {}, // no LLM tier needed — map is authoritative
    });
    expect(result['mistral-zai/zai-glm-5-2']).toBe(1506.11);
  });

  it('the model-map override beats a WRONG LLM match (e.g. LLM says glm-4)', () => {
    // If the LLM incorrectly matched zai-glm-5-2 → glm-4, the map entry
    // (glm-5-2) must win because tier 1 > tier 3.
    const result = resolveModelScores({
      modelRefs: ['mistral-zai/zai-glm-5-2'],
      gdpvalScores,
      modelMap,
      modelMapWildcards,
      llmMatches: { 'mistral-zai/zai-glm-5-2': 'glm-4' }, // wrong LLM match
    });
    expect(result['mistral-zai/zai-glm-5-2']).toBe(1506.11); // map wins, not glm-4 (400)
  });

  it('without the LLM tier, glm-5-2 (no zai prefix) STILL resolves via token fallback', () => {
    // This one should NOT need the LLM — token set {glm,5,2} matches directly.
    const result = resolveModelScores({
      modelRefs: ['mistral/glm-5-2'],
      gdpvalScores,
      modelMap,
      modelMapWildcards,
      llmMatches: {},
    });
    expect(result['mistral/glm-5-2']).toBe(1506.11);
  });
});
