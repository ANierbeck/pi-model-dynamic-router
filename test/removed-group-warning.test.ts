// test/removed-group-warning.test.ts
// Step 4 of docs/plans/2026-10-25-category-group-mismatch.md (D3: no read
// aliases in 2.0). A user/project config written for the 13-group layout still
// names groups that no longer exist. Without a warning, `tactical: { max_gdpval:
// 1900 }` would silently become a stray method-less group while the intended
// code_complex ceiling never applies. The loader must say so, name the
// successor, and drop the stray group — never throw.

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadLayeredConfig, REMOVED_GROUPS } from '../src/config-loader.ts';
import { delegationSettings } from '../src/delegation.ts';

vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return { ...actual, warnLog: vi.fn() };
});
import { SHIPPED_CONFIG, useConfigLayers } from './helpers/config-layer.ts';

const SHIPPED = SHIPPED_CONFIG;
const layers = useConfigLayers('removed-groups');
const { loadWithProjectLayer, warnings } = layers;

describe('a layer that still defines a removed group', () => {
  it('warns, names the successor, and drops the stray group (tactical → code_complex)', () => {
    const { config } = loadWithProjectLayer({ model_groups: { tactical: { max_gdpval: 1900 } } });
    expect(config.model_groups.tactical).toBeUndefined();
    const w = warnings().filter((m) => m.includes('tactical'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('code_complex');
  });

  it('does not touch the shipped successor — the owner must move the value', () => {
    const { config } = loadWithProjectLayer({ model_groups: { tactical: { max_gdpval: 1900 } } });
    expect(config.model_groups.code_complex.max_gdpval).toBe(1700);
  });

  it('every removed name has a successor that exists in the shipped config', () => {
    const shipped = JSON.parse(fs.readFileSync(SHIPPED, 'utf-8'));
    for (const [oldName, successor] of Object.entries(REMOVED_GROUPS)) {
      expect(shipped.model_groups[oldName], oldName).toBeUndefined();
      expect(shipped.model_groups[successor], `${oldName} → ${successor}`).toBeDefined();
    }
    expect(Object.keys(REMOVED_GROUPS).sort()).toEqual([
      'complex',
      'fallback',
      'operational',
      'scout',
      'strategic',
      'tactical',
      'trivial',
    ]);
  });

  it('warns once per removed group, for several at once', () => {
    loadWithProjectLayer({
      model_groups: { scout: { fallback_groups: ['fallback'] }, strategic: { min_gdpval: 900 } },
    });
    const w = warnings();
    expect(w.filter((m) => m.includes('"scout"'))).toHaveLength(1);
    expect(w.filter((m) => m.includes('"strategic"'))).toHaveLength(1);
    expect(w.find((m) => m.includes('"strategic"'))).toContain('planning');
  });
});

describe('prototype keys are not group names', () => {
  // Regression (review round on laya-spike, 2026-10-29): `name in
  // REMOVED_GROUPS` also matched Object.prototype keys, so a layer defining a
  // group literally named "constructor" was warned about ("moved to
  // \"undefined\"") and deleted. Own-key check only.
  it('a group named like a prototype key is not a removed group', () => {
    loadWithProjectLayer({ model_groups: { constructor: { min_gdpval: 1600 } } });
    expect(warnings().some((m) => m.includes('removed group'))).toBe(false);
  });

  it('a fallback_groups entry named like a prototype key stays in the chain', () => {
    const { config } = loadWithProjectLayer({
      model_groups: { standard: { fallback_groups: ['toString', 'simple'] } },
    });
    expect(config.model_groups.standard.fallback_groups).toEqual(['toString', 'simple']);
    expect(warnings().some((m) => m.includes('removed group'))).toBe(false);
  });
});

describe('references to a removed group', () => {
  it('a fallback_groups entry naming a removed group is warned and dropped from the chain', () => {
    const { config } = loadWithProjectLayer({
      model_groups: { standard: { fallback_groups: ['operational', 'simple'] } },
    });
    expect(config.model_groups.standard.fallback_groups).toEqual(['simple']);
    const w = warnings().filter((m) => m.includes('operational'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('standard');
  });

  it('delegation.expensive_groups naming a removed group is warned and dropped', () => {
    const { config } = loadWithProjectLayer({
      delegation: { expensive_groups: ['strategic', 'planning'] },
    });
    expect(config.delegation?.expensive_groups).toEqual(['planning']);
    expect(warnings().filter((m) => m.includes('strategic'))).toHaveLength(1);
  });
});

describe('only override layers are checked', () => {
  it('names the offending file, and leaves the embedded defaults alone', () => {
    // A fixture default that still has an old name: it is the shipped layer,
    // not a user layer, so it is neither warned about nor dropped.
    const shipped = JSON.parse(fs.readFileSync(SHIPPED, 'utf-8'));
    shipped.model_groups.tactical = { method: 'best' };
    fs.writeFileSync(path.join(layers.paths.ext, 'router-config.json'), JSON.stringify(shipped));
    const { config } = loadWithProjectLayer({ model_groups: { operational: { min_gdpval: 1 } } });
    expect(config.model_groups.tactical).toBeDefined();
    const w = warnings().filter((m) => m.includes('removed group'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(path.join(layers.paths.cwd, '.pi', 'router-config.json'));
  });
});

describe('a list that held only removed names', () => {
  it('expensive_groups falls back to the defaults — an emptied list would silently disable the read block', () => {
    const { config } = loadWithProjectLayer({
      delegation: { expensive_groups: ['strategic', 'tactical'] },
    });
    expect(delegationSettings(config).expensive_groups).toEqual(['planning', 'code_complex']);
    expect(warnings().filter((m) => m.includes('removed group'))).toHaveLength(2);
  });
});

describe('a clean layer', () => {
  it('the shipped config alone produces no removed-group warning', () => {
    loadLayeredConfig(layers.paths.ext, layers.paths.cwd);
    expect(warnings().filter((m) => m.includes('removed group'))).toEqual([]);
  });

  it('a layer using only the new names produces none either', () => {
    loadWithProjectLayer({
      model_groups: {
        code_complex: { max_gdpval: 1900 },
        simple: { fallback_groups: ['standard'] },
      },
      delegation: { expensive_groups: ['planning', 'code_complex'] },
    });
    expect(warnings().filter((m) => m.includes('removed group'))).toEqual([]);
  });
});

// The pre-2.0 classifier keys are no longer dropped: they move to the
// `classifier` block with a warning (plan 2026-11-14-config-surface-and-ui.md,
// decision 2). Pinned in test/classifier-config-block.test.ts.
