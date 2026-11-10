// test/config-schema.test.ts
//
// Plan 2026-11-08-optional-integrations-config.md, decision 2: a hand-maintained
// known-key set plus a test that it matches `Config`, and unknown-key warnings
// for the user and project layers (a typo such as `classifer_laya` must not be
// merged and silently ignored).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closestKey, KNOWN_TOP_LEVEL_KEYS, unknownTopLevelKeys } from '../src/config-schema.ts';
import { loadLayeredConfig } from '../src/config-loader.ts';
import { rmTmpDir } from './helpers/router-env.ts';

const warnings: string[] = [];
vi.mock('../src/logger.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/logger.ts')>()),
  warnLog: (msg: string): void => {
    warnings.push(msg);
  },
}));

const root = path.join(__dirname, '..');

/** Top-level keys of `interface Config` in src/types.ts, read from the source text. */
function configInterfaceKeys(): string[] {
  const src = fs.readFileSync(path.join(root, 'src', 'types.ts'), 'utf-8');
  const start = src.indexOf('export interface Config {');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(start, end);
  return [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1] as string);
}

describe('known top-level keys match Config', () => {
  it('the schema lists exactly the keys of interface Config', () => {
    const fromTypes = configInterfaceKeys().sort();
    expect(fromTypes.length).toBeGreaterThan(15);
    expect(Object.keys(KNOWN_TOP_LEVEL_KEYS).sort()).toEqual(fromTypes);
  });

  it('every key of the shipped router-config.json is known', () => {
    const shipped = JSON.parse(
      fs.readFileSync(path.join(root, 'router-config.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(unknownTopLevelKeys(shipped)).toEqual([]);
  });
});

describe('unknownTopLevelKeys', () => {
  it('reports unknown keys, ignoring comment/schema keys that start with _ or $', () => {
    expect(
      unknownTopLevelKeys({ log_level: 'warn', _comment: 'x', $schema: 'y', bogus: 1 })
    ).toEqual(['bogus']);
  });

  it('does not treat inherited names as known keys (prototype keys are unknown)', () => {
    expect(unknownTopLevelKeys(JSON.parse('{"constructor": 1, "toString": 2}'))).toEqual([
      'constructor',
      'toString',
    ]);
  });
});

describe('closestKey', () => {
  const known = ['classifier_log', 'model_groups', 'exclude', 'providers'];

  it('suggests the key within a small edit distance', () => {
    expect(closestKey('classifer_log', known)).toBe('classifier_log');
    expect(closestKey('model_group', known)).toBe('model_groups');
    expect(closestKey('excluded', known)).toBe('exclude');
  });

  it('applies both guards: at most 2 edits, and under a third of the key length', () => {
    // 2 edits on a 9-char key: allowed. 3 edits on a 10-char key: the distance guard alone refuses.
    expect(closestKey('excludeee', known)).toBe('exclude');
    expect(closestKey('excludeeee', known)).toBeUndefined();
    // 1 edit on a 3-char key: the length guard alone refuses (1 is not under 3/3).
    expect(closestKey('abd', ['abc'])).toBeUndefined();
  });

  it('compares case-insensitively (a capitalised key is a typo of the lower-case one)', () => {
    expect(closestKey('EXCLUDE', known)).toBe('exclude');
  });

  it('suggests nothing when nothing is close', () => {
    expect(closestKey('zzzzzzzz', known)).toBeUndefined();
    expect(closestKey('ab', known)).toBeUndefined();
  });
});

describe('loadLayeredConfig: unknown-key warnings', () => {
  let tmp: string;
  let extDir: string;
  let cwdDir: string;
  let agentDir: string;

  beforeEach(() => {
    warnings.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-schema-'));
    extDir = path.join(tmp, 'ext');
    cwdDir = path.join(tmp, 'cwd');
    agentDir = path.join(tmp, 'agent');
    for (const d of [extDir, cwdDir, agentDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'router-config.json'),
      JSON.stringify({ model_groups: {}, model_metrics: {} })
    );
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmTmpDir(tmp);
  });

  const userFile = (): string => path.join(agentDir, 'router-config.user.json');
  const projectFile = (): string => path.join(cwdDir, '.pi', 'router-config.json');

  it('warns once per file about an unknown user-layer key, naming the file and the closest key', () => {
    fs.writeFileSync(userFile(), JSON.stringify({ classifer_log: { enabled: true }, zzz: 1 }));
    loadLayeredConfig(extDir, cwdDir);
    const hits = warnings.filter((w) => w.includes('unknown'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(userFile());
    expect(hits[0]).toContain('"classifer_log"');
    expect(hits[0]).toContain('did you mean "classifier_log"');
    expect(hits[0]).toContain('"zzz"');
  });

  it('checks the project layer too', () => {
    fs.mkdirSync(path.join(cwdDir, '.pi'), { recursive: true });
    fs.writeFileSync(projectFile(), JSON.stringify({ excluded: { models: [] } }));
    loadLayeredConfig(extDir, cwdDir);
    const hit = warnings.find((w) => w.includes('unknown') && w.includes(projectFile()));
    expect(hit).toContain('did you mean "exclude"');
  });

  it('stays silent for known keys, and does not check the shipped defaults', () => {
    fs.writeFileSync(
      path.join(extDir, 'router-config.json'),
      JSON.stringify({ model_groups: {}, model_metrics: {}, from_shipped_only: 1 })
    );
    fs.writeFileSync(userFile(), JSON.stringify({ log_level: 'warn', exclude: { models: [] } }));
    loadLayeredConfig(extDir, cwdDir);
    expect(warnings.filter((w) => w.includes('unknown'))).toEqual([]);
  });

  // Owner decision 2026-11-08 (plan decision 1): the Laya block moved from the
  // top-level `classifier_laya` to `integrations.laya` with no read alias —
  // but never silently: an old block would otherwise lose the setting and the
  // stage would sit at the shipped default (off) without a word.
  describe('classifier_laya was renamed to integrations.laya', () => {
    const OLD = { classifier_laya: { enabled: true, checkpoint: 'x/y' } };

    it('warns once in the user layer, names the new key, and does not apply the old block', () => {
      fs.writeFileSync(userFile(), JSON.stringify(OLD));
      const { config } = loadLayeredConfig(extDir, cwdDir);
      const hits = warnings.filter((w) => w.includes('classifier_laya'));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain(userFile());
      expect(hits[0]).toContain('integrations.laya');
      expect(config.integrations?.laya?.enabled).not.toBe(true);
      expect(Object.hasOwn(config, 'classifier_laya')).toBe(false);
    });

    it('warns in the project layer too', () => {
      fs.mkdirSync(path.join(cwdDir, '.pi'), { recursive: true });
      fs.writeFileSync(projectFile(), JSON.stringify(OLD));
      loadLayeredConfig(extDir, cwdDir);
      expect(
        warnings.some((w) => w.includes(projectFile()) && w.includes('integrations.laya'))
      ).toBe(true);
    });

    it('is reported as renamed only, not additionally as an unknown key', () => {
      fs.writeFileSync(userFile(), JSON.stringify(OLD));
      loadLayeredConfig(extDir, cwdDir);
      expect(warnings.filter((w) => w.includes('unknown'))).toEqual([]);
    });

    it('the new key works in a user layer', () => {
      fs.writeFileSync(
        userFile(),
        JSON.stringify({ integrations: { laya: { enabled: true, checkpoint: 'r2@1.0.0' } } })
      );
      const { config } = loadLayeredConfig(extDir, cwdDir);
      expect(config.integrations?.laya?.enabled).toBe(true);
      expect(config.integrations?.laya?.mode).toBe('shadow');
      expect(warnings).toEqual([]);
    });
  });

  it('warns, never throws, and still merges the layer (routing is not broken by a typo)', () => {
    fs.writeFileSync(userFile(), JSON.stringify({ bogus: 1, log_level: 'debug' }));
    const { config } = loadLayeredConfig(extDir, cwdDir);
    expect(config.log_level).toBe('debug');
  });
});
