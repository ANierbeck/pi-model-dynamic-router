// test/fallback-naming.test.ts
// Ratchet + rename guard for docs/plans/2026-10-25-fallback-naming.md.
//
// The word "fallback" named six different things. The owner's test (2026-10-26):
// "fallback" must mean *everything I tried failed, now something else". Where a
// name says exactly that it stays (stream retry, failure cascade
// `fallback_groups`, the local second classifier, the static classifier, the
// decision-log stage `fallback`). Where it does not, it was renamed:
//
//   - the classifier's cloud chain (`classifier_cloud_chain`, `allowCloudChain`,
//     `callCloudChain`, `classifier-cloud-probe.ts`, `classifier_cloud_models`)
//     — the normal cloud path, not a fallback, renamed 2026-11-08;
//   - the retired category `fallback` (replaced by `continue` in v2-r3) — dead
//     vocabulary, deleted;
//   - the model group `fallback` — a pool, not an event; gone with the
//     five-group layout.
//
// Two guards, because either alone would rot:
//   1. the OLD names must not come back (a rename that is half-undone compiles
//      and silently changes behaviour);
//   2. a NEW identifier containing "fallback" must be added to the honest list
//      below, i.e. the author has to say which honest meaning it is.
//
// Red evidence (2026-11-08): before the rename, guard 1 fails on every old
// identifier; guard 2's allowlist was derived from the tree AFTER the rename,
// so adding e.g. `cloudFallbackModels` to src/ makes it fail (checked by hand).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every shipped source file (the extension bundle's input). */
function shippedSources(): string[] {
  return [join(ROOT, 'index.ts'), ...tsFiles(join(ROOT, 'src'))];
}

const rel = (p: string): string => p.slice(ROOT.length + 1);

/** The renamed cloud-chain vocabulary. None of it may come back. */
const RETIRED_NAMES = [
  'classifier_cloud_fallback',
  'allowCloudFallback',
  'callCloudFallback',
  'classifier_fallback_models',
  'classifier_fallback_probe_sig',
  'getCachedFallbackModels',
  'hasProbedFallback',
  'classifier-fallback-probe',
];

describe('fallback naming — the renamed cloud chain stays renamed', () => {
  it('no shipped source or test names the old cloud-chain vocabulary', () => {
    const files = [...shippedSources(), ...tsFiles(join(ROOT, 'test'))];
    // Three deliberate exceptions, all about the RENAME itself rather than a
    // use of the old name: this file lists the retired vocabulary, the loader's
    // rename map has to spell the old key to warn about it, and the loader test
    // feeds the old key in to prove the warning fires.
    const ALLOWED = new Set([
      'test/fallback-naming.test.ts',
      'test/removed-group-warning.test.ts',
      'src/config-loader.ts: classifier_cloud_fallback',
    ]);
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const name of RETIRED_NAMES) {
        const key = `${rel(f)}: ${name}`;
        if (ALLOWED.has(key) || ALLOWED.has(rel(f))) continue;
        if (text.includes(name)) hits.push(key);
      }
    }
    expect(hits, 'the cloud chain was renamed in 2.0 (fallback-naming plan)').toEqual([]);
  });

  it('the probe file and its tests are named after the cloud chain', () => {
    expect(readdirSync(join(ROOT, 'src'))).toContain('classifier-cloud-probe.ts');
    expect(readdirSync(join(ROOT, 'src'))).not.toContain('classifier-fallback-probe.ts');
    expect(readdirSync(join(ROOT, 'test'))).toContain('classifier-cloud-probe.test.ts');
  });

  it('the shipped config uses the new key', () => {
    const cfg = readFileSync(join(ROOT, 'router-config.json'), 'utf8');
    expect(cfg).toContain('classifier_cloud_chain');
    expect(cfg).not.toContain('classifier_cloud_fallback');
  });
});

describe('fallback naming — a new "fallback" identifier needs a stated meaning', () => {
  /**
   * The honest meanings (owner 2026-10-26). An identifier that is not listed
   * here and contains "fallback" fails the guard — add it with the meaning it
   * expresses, or rename it.
   */
  const HONEST = new Set([
    // B — failure cascade between groups
    'fallback_groups',
    'FALLBACK_GROUP_ORDER',
    'getFallbackGroup',
    'computeFallbackGroups',
    'hintFallbacks',
    'fallbackGroup',
    'fallbackGroups',
    'fallbackGroupsFor',
    // C — the local second classifier and the static classifier
    'classifier_fallback',
    'fallbackModel',
    'fallbackTimeoutMs',
    'allowStaticFallback',
    'fallbackModels',
    'fallbackModelRef',
    'pinnedFallbackModel',
    // D — decision-log stage: no classifier answered
    'fallback',
    // F — stream-level retry / next candidate
    'tryFallback',
    'fallbackCandidates',
    'fallbackError',
    'fallbackFailed',
    'fallbackInfo',
    'fallbackChain',
    'fallbackLabel',
    'fallbackNote',
    'fallbackReason',
    // G — ordinary English parameters and prose
    'SUBSCRIPTION_FALLBACK_COST',
    'orFallbackPrice',
    'fallbackCost',
    'fallbackValue',
  ]);

  it('every "fallback" identifier in shipped source is an honest meaning', () => {
    const unknown = new Set<string>();
    for (const f of shippedSources()) {
      // The rename map in config-loader must spell the old key to warn about
      // it — that is the rename, not a use (see the guard above).
      if (rel(f) === 'src/config-loader.ts') continue;
      const text = readFileSync(f, 'utf8');
      // Identifiers only (not prose): camelCase, snake_case or ALL_CAPS tokens.
      for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*[Ff]allback[A-Za-z0-9_]*)\b/g)) {
        const id = m[1];
        if (HONEST.has(id)) continue;
        unknown.add(id);
      }
    }
    expect(
      [...unknown].sort(),
      'new "fallback" identifier(s): add them to HONEST with the meaning they express, or rename them (fallback-naming plan)'
    ).toEqual([]);
  });
});
