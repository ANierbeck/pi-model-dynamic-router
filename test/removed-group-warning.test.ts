// test/removed-group-warning.test.ts
// Step 4 of docs/plans/2026-10-25-category-group-mismatch.md (D3: no read
// aliases in 2.0). A user/project config written for the 13-group layout still
// names groups that no longer exist. Without a warning, `tactical: { max_gdpval:
// 1900 }` would silently become a stray method-less group while the intended
// code_complex ceiling never applies. The loader must say so, name the
// successor, and drop the stray group — never throw.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadLayeredConfig, REMOVED_GROUPS } from '../src/config-loader.ts';
import { delegationSettings } from '../src/delegation.ts';

vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return { ...actual, warnLog: vi.fn() };
});
import * as loggerModule from '../src/logger.ts';
const mockWarnLog = vi.mocked(loggerModule.warnLog);

const SHIPPED = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'router-config.json');

let tmpDir: string;
let extDir: string;
let cwdDir: string;

function loadWithProjectLayer(layer: unknown) {
  fs.mkdirSync(path.join(cwdDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(cwdDir, '.pi', 'router-config.json'), JSON.stringify(layer));
  return loadLayeredConfig(extDir, cwdDir);
}

const warnings = () => mockWarnLog.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-removed-groups-'));
  extDir = path.join(tmpDir, 'ext');
  cwdDir = path.join(tmpDir, 'project');
  fs.mkdirSync(extDir, { recursive: true });
  fs.mkdirSync(cwdDir, { recursive: true });
  fs.copyFileSync(SHIPPED, path.join(extDir, 'router-config.json'));
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

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
    expect(Object.keys(REMOVED_GROUPS).sort()).toEqual(
      ['complex', 'fallback', 'operational', 'scout', 'strategic', 'tactical', 'trivial'],
    );
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

describe('references to a removed group', () => {
  it('a fallback_groups entry naming a removed group is warned and dropped from the chain', () => {
    const { config } = loadWithProjectLayer({ model_groups: { standard: { fallback_groups: ['operational', 'simple'] } } });
    expect(config.model_groups.standard.fallback_groups).toEqual(['simple']);
    const w = warnings().filter((m) => m.includes('operational'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('standard');
  });

  it('delegation.expensive_groups naming a removed group is warned and dropped', () => {
    const { config } = loadWithProjectLayer({ delegation: { expensive_groups: ['strategic', 'planning'] } });
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
    fs.writeFileSync(path.join(extDir, 'router-config.json'), JSON.stringify(shipped));
    const { config } = loadWithProjectLayer({ model_groups: { operational: { min_gdpval: 1 } } });
    expect(config.model_groups.tactical).toBeDefined();
    const w = warnings().filter((m) => m.includes('removed group'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(path.join(cwdDir, '.pi', 'router-config.json'));
  });
});

describe('a list that held only removed names', () => {
  it('expensive_groups falls back to the defaults — an emptied list would silently disable the read block', () => {
    const { config } = loadWithProjectLayer({ delegation: { expensive_groups: ['strategic', 'tactical'] } });
    expect(delegationSettings(config).expensive_groups).toEqual(['planning', 'code_complex']);
    expect(warnings().filter((m) => m.includes('removed group'))).toHaveLength(2);
  });
});

describe('a clean layer', () => {
  it('the shipped config alone produces no removed-group warning', () => {
    loadLayeredConfig(extDir, cwdDir);
    expect(warnings().filter((m) => m.includes('removed group'))).toEqual([]);
  });

  it('a layer using only the new names produces none either', () => {
    loadWithProjectLayer({
      model_groups: { code_complex: { max_gdpval: 1900 }, simple: { fallback_groups: ['standard'] } },
      delegation: { expensive_groups: ['planning', 'code_complex'] },
    });
    expect(warnings().filter((m) => m.includes('removed group'))).toEqual([]);
  });
});
