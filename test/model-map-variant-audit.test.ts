// test/model-map-variant-audit.test.ts
// model-map.yaml is the first and authoritative lookup in resolveSlug — the
// variant-token veto (src/slug-matcher.ts) never second-guesses it. So a map
// entry that points a variant ref at its sibling's record hands the sibling's
// score to a different model, the same defect class the veto closes for the
// fuzzy and LLM matchers (D1/D2 of the 2026-10-10 model-identity plan).
// Identity audit D5 (quality-cascade worktree, 2026-10-10): two shipped
// entries did exactly that, while AA lists each model under its own slug:
//   openai/gpt-4o-mini                  -> gpt-4o       (AA: gpt-4o-mini)
//   Qwen/Qwen3-235B-A22B-Thinking-2507  -> ...-instruct-2507
//                                          (AA: qwen3-235b-a22b-instruct-2507-reasoning,
//                                           "Qwen3 235B A22B 2507 (Reasoning)")
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { variantVeto } from '../src/slug-matcher.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const map = YAML.parse(fs.readFileSync(path.join(here, '..', 'model-map.yaml'), 'utf8')) as Record<
  string,
  string | null
>;

describe('model-map.yaml — no entry maps a variant ref to its sibling record', () => {
  it('passes the variant-token veto for every scored entry', () => {
    const vetoed = Object.entries(map)
      .filter(([ref, slug]) => typeof slug === 'string' && variantVeto(ref, slug))
      .map(([ref, slug]) => `${ref} -> ${slug}`);
    expect(vetoed).toEqual([]);
  });

  it('maps the Thinking-2507 Qwen to the reasoning record, not to the Instruct one', () => {
    // The token veto cannot see this pair (Thinking/Instruct are inference
    // modes, and AA spells the thinking model "instruct-2507-reasoning"), so
    // it is pinned by name.
    expect(map['Qwen/Qwen3-235B-A22B-Thinking-2507']).toBe(
      'qwen3-235b-a22b-instruct-2507-reasoning'
    );
  });
});
