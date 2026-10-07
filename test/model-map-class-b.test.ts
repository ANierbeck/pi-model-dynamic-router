// test/model-map-class-b.test.ts — ADR-0025 class-B classification pin for
// model-map.yaml (owner decision 2026-10-07: classify explicitly as class B,
// do NOT extend the guard scope).
//
// model-map.yaml is shipped name-keyed ANNOTATION data: it answers "which
// GDPval slug does this model ref mean?" (Q1, resolveSlug) and "~" entries
// answer "no benchmark score" (Q2, lookupGdp null). Class B per ADR-0025
// §2B: it may only score/identify models Pi already supplied and can NEVER
// admit a candidate. This canary pins both halves of that invariant so a
// future change that grows model-map.yaml into an admission source fails
// loudly instead of silently widening its class (which would force a
// guard-scope extension and a new baseline round).
//
// NOTE (AGENTS.md §4 convention): this is a PIN over an invariant that
// already holds — green at birth by design, never red, because nothing ever
// violated it. Pins are stated explicitly per the suite-hygiene convention
// (the calculate-score contract incident, PR #16).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Cache } from '../src/types.ts';

/** Remove /* block *​/ and // line comments so only executable code remains. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('model-map.yaml class-B invariant (ADR-0025 §2B)', () => {
  it('src/metrics.ts is the ONLY module whose code reads model-map.yaml (single loader, no second access path)', () => {
    // The invariant has two halves: (a) exactly ONE loader exists —
    // `export function loadModelMap` lives only in src/metrics.ts; (b) no
    // other module's executable code combines the file name with a file or
    // YAML access (readFileSync/yaml/parse). Prose mentions in error
    // MESSAGE strings (scan-sanity) and comments are fine — they cannot
    // read anything. index.ts and event-handlers.ts legitimately call
    // metricsModule.loadModelMap(); that is routing the map INTO metrics,
    // not consuming it.
    const files = ['index.ts', ...readdirSync(join(process.cwd(), 'src')).filter((f) => f.endsWith('.ts')).map((f) => `src/${f}`)];
    const loaderDefs: string[] = [];
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (code.includes('export function loadModelMap')) loaderDefs.push(file);
      if (file !== 'src/metrics.ts' && code.includes('model-map.yaml') && /readFileSync|writeFileSync|loadYAML|\.parse\(|import YAML|from 'yaml'/.test(code)) offenders.push(file);
    }
    expect(loaderDefs).toEqual(['src/metrics.ts']);
    expect(offenders, `second access path to model-map.yaml: ${offenders.join(', ')}`).toEqual([]);
  });

  it('an entry for a family nothing supplied conjures NO candidate (never admit)', () => {
    // The map claims a phantom family maps to a real GDPval slug. The pool
    // (available_models) is empty — no scan, no registry, no config supplied
    // the family. A class-B map cannot manufacture supply: the group
    // resolves to nothing.
    const cfg = {
      model_groups: { g: { name: 'g', method: 'best', min_gdpval: 0 } },
      model_metrics: {},
      providers: {},
    } as unknown as Config;
    const cache = { available_models: [] } as unknown as Cache;
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.setModelMap({ 'phantom-family-9': 'claude-3-haiku' }, []);
    metricsModule.setGdpval({ 'claude-3-haiku': 380 });

    expect(new Router(cfg, cache, new Map()).resolve('g')).toBeNull();
  });

  it('a "~" entry unscores a supplied model but keeps it in the pool (annotate, not admit or remove)', () => {
    // voxtral-* has no benchmark score: the model STAYS a candidate under a
    // gate-free group (min_gdpval 0 = no quality gate) while its slug
    // resolution is explicitly null. Under a strict positive gate the
    // unscored model is dropped — that is gate semantics on an annotation
    // value, still not admission or removal of supply.
    const discovered = [{ provider: 'x', id: 'voxtral-large', cost_per_m: 1 }] as any;
    const base = {
      model_groups: { g: { name: 'g', method: 'best', min_gdpval: 0 }, strict: { name: 'strict', method: 'best', min_gdpval: 1 } },
      model_metrics: {},
      providers: {},
    };

    const world = (groupsPatch: Record<string, unknown>): { cfg: Config; cache: Cache } => {
      const cfg = { ...base, model_groups: groupsPatch } as unknown as Config;
      const cache = { available_models: discovered } as unknown as Cache;
      metricsModule.setConfig(cfg);
      metricsModule.setCache(cache);
      metricsModule.setModelMap({}, [['voxtral-*', null]]);
      metricsModule.setGdpval({});
      return { cfg, cache };
    };

    const open = world({ g: base.model_groups.g });
    expect(new Router(open.cfg, open.cache, new Map()).resolve('g')!.candidates).toContain('x/voxtral-large');
    expect(metricsModule.resolveSlug('x/voxtral-large')).toBeNull();

    const strict = world({ strict: base.model_groups.strict });
    expect(new Router(strict.cfg, strict.cache, new Map()).resolve('strict')).toBeNull();
  });
});
