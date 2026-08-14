// test/config-loader.test.ts
// Tests for layered config loading + deep merge.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { deepMergeConfig, loadLayeredConfig } from '../src/config-loader.js';
import type { Config } from '../src/types.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Config = {
  providers: {
    openrouter: {
      billing: 'pay_per_token',
      free_models: ['openrouter/qwen3-4b:free', 'openrouter/gpt-4o-mini:free'],
    },
  },
  model_groups: {
    strategic: { method: 'best', min_gdpval: 700 },
    tactical: { method: 'best', min_gdpval: 600 },
  },
  model_metrics: {
    'claude-bridge/claude-opus-5': { cost_per_m: 0.0000015 },
  },
  gdpval_builtin: { 'glm-4': 400, 'claude-sonnet-5': 1603 },
};

describe('deepMergeConfig', () => {
  it('returns base unchanged when override is empty', () => {
    const result = deepMergeConfig(DEFAULT_CONFIG, {});
    expect(result).toEqual(DEFAULT_CONFIG);
  });

  it('adds a new top-level key from the override', () => {
    const result = deepMergeConfig(DEFAULT_CONFIG, {
      exclude: { models: ['*fable*'] },
    });
    expect(result.exclude).toEqual({ models: ['*fable*'] });
    // base keys preserved
    expect(result.providers).toEqual(DEFAULT_CONFIG.providers);
  });

  it('deep-merges nested plain objects (providers.openrouter)', () => {
    const result = deepMergeConfig(DEFAULT_CONFIG, {
      providers: {
        openrouter: {
          billing: 'pay_per_token',
          keys: [{ key: 'or-test-key' }],
        },
      },
    });
    // billing + free_models from base preserved, keys added
    expect(result.providers?.openrouter?.billing).toBe('pay_per_token');
    expect(result.providers?.openrouter?.free_models).toEqual([
      'openrouter/qwen3-4b:free',
      'openrouter/gpt-4o-mini:free',
    ]);
    expect(result.providers?.openrouter?.keys).toEqual([{ key: 'or-test-key' }]);
  });

  it('REPLACES arrays rather than merging them (exclude.models overrides)', () => {
    const base: Config = {
      ...DEFAULT_CONFIG,
      exclude: { models: ['default-a', 'default-b'] },
    };
    const result = deepMergeConfig(base, {
      exclude: { models: ['override-only'] },
    });
    expect(result.exclude?.models).toEqual(['override-only']);
  });

  it('overrides a primitive value', () => {
    const result = deepMergeConfig(DEFAULT_CONFIG, {
      model_groups: {
        strategic: { method: 'tiered', min_gdpval: 800 },
      },
    });
    expect(result.model_groups?.strategic?.method).toBe('tiered');
    expect(result.model_groups?.strategic?.min_gdpval).toBe(800);
    // other group preserved
    expect(result.model_groups?.tactical).toEqual({ method: 'best', min_gdpval: 600 });
  });

  it('handles override with null values (sets to null)', () => {
    const result = deepMergeConfig(DEFAULT_CONFIG, {
      gdpval_builtin: null as any,
    });
    expect(result.gdpval_builtin).toBeNull();
  });
});

// ── loadLayeredConfig (with real temp files) ──────────────────────────────

describe('loadLayeredConfig', () => {
  let tmpDir: string;
  let extDir: string;
  let cwdDir: string;
  let globalDir: string;
  let origHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cfg-test-'));
    extDir = path.join(tmpDir, 'ext');
    cwdDir = path.join(tmpDir, 'project');
    globalDir = path.join(tmpDir, 'home', '.pi', 'agent');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(cwdDir, { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });

    // Write the embedded default config.
    fs.writeFileSync(
      path.join(extDir, 'router-config.json'),
      JSON.stringify(DEFAULT_CONFIG)
    );

    // Fake HOME so the global override path resolves under tmpDir.
    origHome = process.env.HOME ?? '';
    process.env.HOME = path.join(tmpDir, 'home');
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads only the embedded defaults when no overrides exist', () => {
    const { config, sources } = loadLayeredConfig(extDir, cwdDir);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(sources).toEqual([path.join(extDir, 'router-config.json')]);
  });

  it('merges a global user override (~/.pi/agent/router-config.user.json)', () => {
    fs.writeFileSync(
      path.join(globalDir, 'router-config.user.json'),
      JSON.stringify({ exclude: { paid_models_from: ['openrouter'] } })
    );
    const { config, sources } = loadLayeredConfig(extDir, cwdDir);
    expect(config.exclude?.paid_models_from).toEqual(['openrouter']);
    // defaults preserved
    expect(config.gdpval_builtin).toEqual(DEFAULT_CONFIG.gdpval_builtin);
    expect(sources).toHaveLength(2);
    expect(sources[1]).toBe(path.join(globalDir, 'router-config.user.json'));
  });

  it('merges a project-local override (.pi/router-config.json)', () => {
    fs.mkdirSync(path.join(cwdDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(cwdDir, '.pi', 'router-config.json'),
      JSON.stringify({ exclude: { models: ['*fable*'] } })
    );
    const { config, sources } = loadLayeredConfig(extDir, cwdDir);
    expect(config.exclude?.models).toEqual(['*fable*']);
    expect(sources).toHaveLength(2);
  });

  it('project override wins over global override (applied last)', () => {
    // Global sets exclude.models = ['global-only']
    fs.writeFileSync(
      path.join(globalDir, 'router-config.user.json'),
      JSON.stringify({ exclude: { models: ['global-only'], paid_models_from: ['openrouter'] } })
    );
    // Project sets exclude.models = ['project-only'] (should REPLACE global's list)
    fs.mkdirSync(path.join(cwdDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(cwdDir, '.pi', 'router-config.json'),
      JSON.stringify({ exclude: { models: ['project-only'] } })
    );

    const { config } = loadLayeredConfig(extDir, cwdDir);
    // models REPLACED by project (arrays replace, not merge)
    expect(config.exclude?.models).toEqual(['project-only']);
    // paid_models_from from global preserved (project didn't touch it)
    expect(config.exclude?.paid_models_from).toEqual(['openrouter']);
  });

  it('three layers: defaults + global + project', () => {
    fs.writeFileSync(
      path.join(globalDir, 'router-config.user.json'),
      JSON.stringify({ exclude: { paid_models_from: ['openrouter'] } })
    );
    fs.mkdirSync(path.join(cwdDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(cwdDir, '.pi', 'router-config.json'),
      JSON.stringify({ exclude: { models: ['*fable*'] } })
    );

    const { config, sources } = loadLayeredConfig(extDir, cwdDir);
    expect(config.exclude?.paid_models_from).toEqual(['openrouter']); // from global
    expect(config.exclude?.models).toEqual(['*fable*']); // from project
    expect(sources).toHaveLength(3);
  });

  it('does not throw when an override file is malformed JSON (logs + skips)', () => {
    fs.writeFileSync(
      path.join(globalDir, 'router-config.user.json'),
      '{ this is not valid json'
    );
    const logs: string[] = [];
    const { config, sources } = loadLayeredConfig(extDir, cwdDir, (msg) => logs.push(msg));
    // Falls back to defaults only.
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(sources).toHaveLength(1);
    expect(logs.some((l) => l.includes('Failed to read override'))).toBe(true);
  });

  it('does not throw when an override file is a JSON array (ignores it)', () => {
    fs.writeFileSync(
      path.join(globalDir, 'router-config.user.json'),
      '["not", "an", "object"]'
    );
    const { config, sources } = loadLayeredConfig(extDir, cwdDir);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(sources).toHaveLength(1);
  });
});
