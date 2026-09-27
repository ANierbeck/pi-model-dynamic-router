// test/agent-capability-tier.test.ts
//
// Locks down the agent-capability tier as a CONFIG-DRIVEN filter
// (owner decision 2026-09-27 evening: the curated family list must be
// configurable identically for all users — key `non_agent_model_prefixes`
// in the normal config layers, shipped default in the embedded
// router-config.json, overridable per layer like every other array key).
//
// The 2026-09-27 incidents: small mistral families pass GDPval floors
// (mistral-small-2603 → slug mistral-small-4, GDPval 349 → passes
// operational's 300; magistral-small → 665 → passes even tactical's 600)
// while producing garbage main-agent work. The tier must therefore filter
// independently of min_gdpval, in EVERY group, and for every provider variant
// (the afternoon incident's top-ranked candidate was the OPENROUTER re-host
// openrouter/mistral/mistral-small-3-2).
//
// The prompt classifier chain keeps these models (explicit owner
// requirement): it never goes through applyGroupFilters, and the structural
// assertion below guards that the chain modules do not grow a dependency on
// the tier predicates.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyGroupFilters } from '../src/routing.ts';
import { isAgentCapableRef, segmentsMatchingPrefix } from '../src/agent-capability.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Group } from '../src/types.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The shipped default families (must match the embedded router-config.json —
// pinned by the defaults test below so the protection cannot silently vanish).
export const SHIPPED_PREFIXES = [
  'mistral-small-',
  'magistral-small-',
  'ministral-',
  'voxtral-',
  'codestral-',
];

// The incident models (all provider variants) + capable controls.
const NON_AGENT_REFS = [
  'mistral/mistral-small-2603',            // evening incident: 349 passes floor 300
  'mistral/mistral-small-latest',          // afternoon incident: 35+ garbage turns
  'openrouter/mistral/mistral-small-3-2',  // afternoon: classifier's top suggestion (openrouter re-host)
  'mistral/magistral-small-latest',        // GDPval 665 — passes even tactical 600
  'mistral/ministral-8b-latest',           // tiny model
  'mistral/voxtral-small-latest',          // audio model serving text turns
  'mistral/codestral-2508',                // code-completion family
];
const CAPABLE_REFS = [
  'mistral/zai-glm-5-3',       // owner's workhorse (GDPval 1643)
  'mistral/mistral-medium-3-5', // scored 933
  'openrouter/qwen3-4b:free',  // generic free model
  'ollama/qwen3.5',            // local
];
const REFS = [...NON_AGENT_REFS, ...CAPABLE_REFS];

// Realistic scanned scores (direct keys — the slug pipeline is exercised by
// the probe integration elsewhere; here the keys resolve directly).
const SCORES: Record<string, number> = {
  'mistral-small-2603': 349.39,
  'mistral-small-latest': 349.39,
  'mistral-small-3-2': 478,
  'magistral-small-latest': 665,
  'zai-glm-5-3': 1643.62,
  'mistral-medium-3-5': 933,
  'qwen3-4b': 400,
  'qwen3.5': 400,
};

function makeCfg(prefixes?: string[]): Config {
  return {
    model_groups: {},
    model_metrics: {},
    non_agent_model_prefixes: prefixes,
    providers: {
      openrouter: { billing: 'pay_per_token' },
      mistral: { billing: 'subscription' },
      ollama: { billing: 'local' },
    },
  } as any;
}

beforeAll(() => {
  metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  metricsModule.setCache({ available_models: [], gdpval_scores: SCORES, llm_matches: {} } as any);
  metricsModule.setGdpval(SCORES);
  metricsModule.setModelMap({}, []);
});

afterAll(() => {
  metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  metricsModule.setGdpval({});
});

describe('agent-capability tier — predicates', () => {
  it('flags every incident family, including provider re-hosts', () => {
    for (const ref of NON_AGENT_REFS) {
      expect(isAgentCapableRef(ref, SHIPPED_PREFIXES, `ref ${ref}`)).toBe(false);
    }
  });

  it('keeps capable models (cloud paid, free, local)', () => {
    for (const ref of CAPABLE_REFS) {
      expect(isAgentCapableRef(ref, SHIPPED_PREFIXES, `ref ${ref}`)).toBe(true);
    }
  });

  it('matches on id path segments (nested re-host ids)', () => {
    // openrouter re-host: the model id itself is 'mistral/mistral-small-3-2'.
    expect(segmentsMatchingPrefix('mistral/mistral-small-3-2', SHIPPED_PREFIXES)).toBe(true);
    expect(segmentsMatchingPrefix('zai-glm-5-3', SHIPPED_PREFIXES)).toBe(false);
  });
});

describe('agent-capability tier — applyGroupFilters wiring (config-driven)', () => {
  it('drops all non-agent models from a floor-300 group (operational), keeping capable ones', () => {
    const g: Group = { method: 'best', min_gdpval: 300 } as any;
    const out = applyGroupFilters(REFS, g, makeCfg(SHIPPED_PREFIXES));
    for (const ref of NON_AGENT_REFS) {
      expect(out, `group must drop ${ref}`).not.toContain(ref);
    }
    for (const ref of CAPABLE_REFS) {
      expect(out, `group must keep ${ref}`).toContain(ref);
    }
  });

  it('drops non-agent models even from floor-0 groups (trivial/simple)', () => {
    const g: Group = { method: 'best', min_gdpval: 0 } as any;
    const out = applyGroupFilters(REFS, g, makeCfg(SHIPPED_PREFIXES));
    for (const ref of NON_AGENT_REFS) {
      expect(out, `floor-0 group must drop ${ref}`).not.toContain(ref);
    }
    expect(out).toContain('mistral/zai-glm-5-3');
    expect(out).toContain('ollama/qwen3.5');
  });

  it('is not gdpval-based: magistral-small (665) drops from a floor-600 group too', () => {
    const g: Group = { method: 'best', min_gdpval: 600 } as any;
    const out = applyGroupFilters(REFS, g, makeCfg(SHIPPED_PREFIXES));
    expect(out).not.toContain('mistral/magistral-small-latest');
    expect(out).toContain('mistral/zai-glm-5-3');
    expect(out).toContain('mistral/mistral-medium-3-5');
  });

  it('key absent → tier explicitly OFF (models pass; users control the filter)', () => {
    // Absence is an explicit choice: a user who strips the key (or sets [])
    // gets no filtering. This is the configurability contract — the shipped
    // default in the embedded router-config.json provides the protection.
    const g: Group = { method: 'best', min_gdpval: 0 } as any;
    const out = applyGroupFilters(REFS, g, makeCfg(undefined));
    for (const ref of NON_AGENT_REFS) {
      expect(out, `key absent must not filter ${ref}`).toContain(ref);
    }
  });

  it('custom list works: only the configured family drops', () => {
    const g: Group = { method: 'best', min_gdpval: 0 } as any;
    const out = applyGroupFilters(REFS, g, makeCfg(['codestral-']));
    expect(out).not.toContain('mistral/codestral-2508');
    expect(out).toContain('mistral/mistral-small-2603');
    expect(out).toContain('mistral/zai-glm-5-3');
  });
});

describe('agent-capability tier — shipped defaults + classifier chain independence', () => {
  it('embedded router-config.json ships the default family list (protection cannot silently vanish)', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'router-config.json'), 'utf-8'));
    const shipped = cfg.non_agent_model_prefixes;
    expect(Array.isArray(shipped)).toBe(true);
    for (const p of SHIPPED_PREFIXES) {
      expect(shipped, `embedded defaults must contain ${p}`).toContain(p);
    }
  });

  it('classifier modules do not depend on the tier predicates (classification keeps small models)', () => {
    const chainModules = [
      'src/classifier-fallback-probe.ts',
      'src/content-classifier.ts',
    ];
    for (const rel of chainModules) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      expect(src, `${rel} must not import the agent-capability tier`).not.toMatch(
        /agent-capability|isAgentCapable/
      );
    }
  });
});
