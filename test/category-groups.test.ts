// test/category-groups.test.ts
// Task-type-balancing Phase 3 (docs/plans/2026-10-05-task-type-balancing.md):
// the category→group mapping becomes configurable via a `category_groups`
// config key (`{ <category>: <group> }`), merged OVER the built-in
// CATEGORY_TO_GROUP. Unknown categories or unknown groups are rejected with
// a warning at load time and the offending entry is ignored; the rest of the
// mapping still applies. Defaults are unchanged for everyone (the shipped
// router-config.json gains no such key).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CATEGORY_TO_GROUP,
  getGroupForCategory,
  setCategoryGroupMapping,
  resetCategoryGroupMapping,
} from '../src/content-classifier.ts';
import { deepMergeConfig, loadLayeredConfig } from '../src/config-loader.ts';
import { DYNAMIC_CONFIG_RESYNC_KEYS, resyncDynamicFromStatic } from '../src/dynamic-config.ts';
import type { Config } from '../src/types.ts';

// The classifier logs through the shared file logger; mock it so the
// validation warnings are assertable without touching real log files.
vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return { ...actual, warnLog: vi.fn() };
});
import * as loggerModule from '../src/logger.ts';
const mockWarnLog = vi.mocked(loggerModule.warnLog);

const BASE_CONFIG: Config = {
  model_groups: {
    simple: { method: 'tiered', min_gdpval: 0, max_cost: 0 },
    standard: { method: 'tiered', min_gdpval: 300, max_cost: 2.0 },
    code_complex: { method: 'best', min_gdpval: 1630, max_gdpval: 1700 },
    design: { method: 'best', min_gdpval: 1600 },
    planning: { method: 'best', min_gdpval: 1700 },
  },
  model_metrics: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  resetCategoryGroupMapping();
});

afterEach(() => {
  resetCategoryGroupMapping();
});

describe('getGroupForCategory with category_groups overrides', () => {
  it('built-in mapping applies when no override is configured', () => {
    expect(getGroupForCategory('code_complex')).toBe('code_complex');
    expect(getGroupForCategory('design')).toBe('design');
    expect(getGroupForCategory('continue')).toBe('standard');
    expect(getGroupForCategory('does-not-exist')).toBe('simple');
  });

  it('a cfg fixture maps code_complex → planning and the resolver follows it', () => {
    const cfg: Config = {
      ...BASE_CONFIG,
      category_groups: { code_complex: 'planning' },
    };
    expect(getGroupForCategory('code_complex', cfg)).toBe('planning');
    // Sibling categories keep their built-in mapping.
    expect(getGroupForCategory('standard', cfg)).toBe('standard');
    expect(getGroupForCategory('continue', cfg)).toBe('standard');
  });

  it('the module-level install (setCategoryGroupMapping) applies without a cfg argument', () => {
    setCategoryGroupMapping({ design: 'code_complex' });
    expect(getGroupForCategory('design')).toBe('code_complex');
    expect(getGroupForCategory('planning')).toBe('planning');
  });

  it('an explicit cfg argument wins over the module-level install', () => {
    setCategoryGroupMapping({ design: 'code_complex' });
    const cfg: Config = { ...BASE_CONFIG, category_groups: { design: 'simple' } };
    expect(getGroupForCategory('design', cfg)).toBe('simple');
  });

  it('an override for one category never leaks into another category', () => {
    const cfg: Config = { ...BASE_CONFIG, category_groups: { simple: 'planning' } };
    expect(getGroupForCategory('simple', cfg)).toBe('planning');
    expect(getGroupForCategory('standard', cfg)).toBe('standard');
  });
});

describe('deepMergeConfig carries category_groups through the layers', () => {
  it('merges category_groups key-by-key across layers (user wins per category)', () => {
    const merged = deepMergeConfig(BASE_CONFIG, {
      category_groups: { code_complex: 'planning' },
    });
    expect(merged.category_groups).toEqual({ code_complex: 'planning' });
    const merged2 = deepMergeConfig(merged, {
      category_groups: { design: 'code_complex' },
    });
    expect(merged2.category_groups).toEqual({ code_complex: 'planning', design: 'code_complex' });
  });

  it('a project layer overrides a single category without dropping the user layer entries', () => {
    const global = deepMergeConfig(BASE_CONFIG, {
      category_groups: { code_complex: 'planning', design: 'code_complex' },
    });
    const project = deepMergeConfig(global, {
      category_groups: { code_complex: 'standard' },
    });
    expect(project.category_groups).toEqual({ code_complex: 'standard', design: 'code_complex' });
  });
});

describe('loadLayeredConfig validates category_groups (warn, never throw)', () => {
  let tmpDir: string;
  let extDir: string;
  let cwdDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-catgroups-'));
    extDir = path.join(tmpDir, 'ext');
    cwdDir = path.join(tmpDir, 'project');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(cwdDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'router-config.json'), JSON.stringify(BASE_CONFIG));
  });

  afterEach(() => {
    // Guard: if a beforeEach threw before assigning tmpDir, there is
    // nothing to clean up.
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a valid mapping silently (no warning)', () => {
    fs.mkdirSync(path.join(cwdDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(cwdDir, '.pi', 'router-config.json'),
      JSON.stringify({ category_groups: { code_complex: 'planning' } })
    );
    const { config } = loadLayeredConfig(extDir, cwdDir);
    expect(config.category_groups).toEqual({ code_complex: 'planning' });
    expect(mockWarnLog).not.toHaveBeenCalled();
  });

  it('rejects an unknown category with a warning and keeps the valid sibling entry', () => {
    fs.mkdirSync(path.join(cwdDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(cwdDir, '.pi', 'router-config.json'),
      JSON.stringify({ category_groups: { not_a_category: 'planning', code_complex: 'planning' } })
    );
    const { config } = loadLayeredConfig(extDir, cwdDir);
    // The offending entry is dropped; the valid sibling still applies.
    expect(config.category_groups).toEqual({ code_complex: 'planning' });
    expect(getGroupForCategory('code_complex', config)).toBe('planning');
    expect(getGroupForCategory('not_a_category', config)).toBe('simple');
    // The warning names the offending entry.
    expect(mockWarnLog).toHaveBeenCalledTimes(1);
    const msg = String(mockWarnLog.mock.calls[0][0]);
    expect(msg).toContain('category_groups');
    expect(msg).toContain('not_a_category');
  });

  it('rejects an unknown group with a warning and keeps the valid sibling entry', () => {
    fs.mkdirSync(path.join(cwdDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(cwdDir, '.pi', 'router-config.json'),
      JSON.stringify({ category_groups: { design: 'no_such_group', simple: 'standard' } })
    );
    const { config } = loadLayeredConfig(extDir, cwdDir);
    expect(config.category_groups).toEqual({ simple: 'standard' });
    expect(getGroupForCategory('design', config)).toBe('design'); // built-in stands
    expect(getGroupForCategory('simple', config)).toBe('standard');
    expect(mockWarnLog).toHaveBeenCalledTimes(1);
    const msg = String(mockWarnLog.mock.calls[0][0]);
    expect(msg).toContain('category_groups');
    expect(msg).toContain('no_such_group');
    expect(msg).toContain('design');
  });

  it('rejects a non-string group value with a warning', () => {
    fs.mkdirSync(path.join(cwdDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(cwdDir, '.pi', 'router-config.json'),
      JSON.stringify({ category_groups: { design: 42 } })
    );
    const { config } = loadLayeredConfig(extDir, cwdDir);
    expect(config.category_groups).toEqual({});
    expect(mockWarnLog).toHaveBeenCalledTimes(1);
  });

  it('does not warn when no category_groups key is configured', () => {
    const { config } = loadLayeredConfig(extDir, cwdDir);
    expect(config.category_groups).toBeUndefined();
    expect(mockWarnLog).not.toHaveBeenCalled();
  });
});

describe('category_groups survives the dynamic-config resync (user intent)', () => {
  it('is in DYNAMIC_CONFIG_RESYNC_KEYS so a stale dynamic file cannot shadow it', () => {
    expect(DYNAMIC_CONFIG_RESYNC_KEYS).toContain('category_groups');
  });

  it('resyncDynamicFromStatic copies the static mapping into the dynamic config', () => {
    const staticCfg = {
      ...BASE_CONFIG,
      category_groups: { code_complex: 'planning' },
    } as Config;
    const dyn = {
      model_groups: { code_complex: { method: 'best' } },
      category_groups: { code_complex: 'code_complex' }, // stale value from an old file
    } as unknown as Config;
    resyncDynamicFromStatic(dyn, staticCfg);
    expect(dyn.category_groups).toEqual({ code_complex: 'planning' });
  });

  it('resyncDynamicFromStatic installs the mapping when the dynamic file predates the key', () => {
    const staticCfg = {
      ...BASE_CONFIG,
      category_groups: { design: 'code_complex' },
    } as Config;
    const dyn = {
      model_groups: { tactical: { method: 'best' } },
    } as unknown as Config;
    resyncDynamicFromStatic(dyn, staticCfg);
    expect(dyn.category_groups).toEqual({ design: 'code_complex' });
  });
});

describe('built-in mapping is unchanged (defaults for everyone)', () => {
  it('CATEGORY_TO_GROUP maps the seven v2 categories to their groups', () => {
    expect(CATEGORY_TO_GROUP).toEqual({
      simple: 'simple',
      code_simple: 'simple',
      standard: 'standard',
      code_complex: 'code_complex',
      design: 'design',
      planning: 'planning',
      continue: 'standard',
    });
  });

  it('the shipped router-config.json gains no category_groups key', () => {
    const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const shipped = JSON.parse(fs.readFileSync(path.join(repo, 'router-config.json'), 'utf-8'));
    expect(shipped.category_groups).toBeUndefined();
  });
});
