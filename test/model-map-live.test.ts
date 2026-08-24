// test/model-map-live.test.ts
// Regression guard against the original GLM bug, run against the REAL
// model-map.yaml (not a fixture) AND the REAL production resolution
// pipeline (src/metrics.ts resolveSlug/lookupGdp — see its docstring for
// the authoritative precedence). Proves that vendor-prefixed Mistral-hosted
// GLM model ids are resolved by the model-map tier — i.e. the map entries
// are authoritative and don't need the LLM tier to appear in the router
// table.
//
// NOTE (A2): this test used to exercise src/model-matcher.ts's
// resolveModelScores, a second, dead GDPval-resolution pipeline that had
// drifted from the real one (different stage order, weaker token matcher).
// It was removed; this file now goes through the SAME pipeline production
// code actually uses (metrics.ts), so a pass here means the real router
// behaves this way — not just a parallel reimplementation.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lookupGdp, setConfig, setCache, setGdpval, setModelMap, setLlmMatches } from '../src/metrics.js';

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
  'glm-5-3': 1769,
  'glm-53': 1769,
  'glm-5': 1418,
  'mistral-medium-3-5': 924.55,
};

beforeEach(() => {
  setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  setGdpval({});
  setLlmMatches({});
  setModelMap(modelMap, modelMapWildcards);
  setCache({ gdpval_scores: gdpvalScores });
});

describe('model-map.yaml (live) — GLM regression guard', () => {
  it('CONTAINS authoritative map entries for the Mistral-hosted glm-5-2 ids (override the LLM)', () => {
    // The LLM matcher sometimes mis-matches glm-5-2 → glm-4 (older slug).
    // The model-map entries are authoritative (tier 1) and prevent this.
    // GLM-5-2 maps to glm-5-3 (the current AA slug; glm-5-2 was deprecated).
    expect(modelMap['glm-5-2']).toBe('glm-5-3');
    expect(modelMap['zai-glm-5-2']).toBe('glm-5-3');
    expect(modelMap['glm-5-2-tee']).toBe('glm-5-3');
  });

  it('the model-map resolves zai-glm-5-2 → glm-5-3 → 1769 (tier 0, no LLM needed)', () => {
    expect(lookupGdp('mistral-zai/zai-glm-5-2')).toBe(1769);
  });

  it('the model-map override beats a WRONG LLM match (e.g. LLM says glm-4)', () => {
    // If the LLM incorrectly matched zai-glm-5-2 → glm-4, the map entry
    // (glm-5-3) must win because the model-map tier is checked BEFORE the
    // LLM tier in resolveSlug().
    setLlmMatches({ 'mistral-zai/zai-glm-5-2': 'glm-4' }); // wrong LLM match
    expect(lookupGdp('mistral-zai/zai-glm-5-2')).toBe(1769); // map wins, not glm-4
  });

  it('without the LLM tier, glm-5-2 (no zai prefix) STILL resolves via the map', () => {
    expect(lookupGdp('mistral/glm-5-2')).toBe(1769);
  });
});
