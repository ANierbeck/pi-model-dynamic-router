/**
 * ADR-0025 guard: shipped source and the shipped default config must not
 * name a concrete model where it can admit, select, rank or exclude one.
 * The tolerated literals live in a ratcheting baseline
 * (scripts/hardcoded-model-baseline.json) that may only shrink.
 *
 * The scanner itself is pure (scripts/scan-hardcoded-models.ts); this file
 * owns all file-system access and feeds it the real family-token list from
 * src/model-matcher.ts and the provider identifiers from src/providers.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROVIDER_MAP, PI_BUILTIN_PROVIDER_IDS } from '../src/providers.ts';
import {
  scanSourceText,
  isScannedSourcePath,
  scanConfig,
  toBaselineEntries,
  compareToBaseline,
  type BaselineEntry,
  type HardcodedFinding,
} from '../scripts/scan-hardcoded-models.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The family tokens of src/model-matcher.ts's MODEL_FAMILIES table. That
 * table is module-private, so the tokens are read from its source text —
 * keeps the guard coupled to the one real list without touching src/.
 */
function readFamilyTokens(): string[] {
  const text = readFileSync(path.join(REPO_ROOT, 'src/model-matcher.ts'), 'utf-8');
  const table = /const MODEL_FAMILIES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(text);
  if (!table) throw new Error('MODEL_FAMILIES table not found in src/model-matcher.ts');
  const tokens: string[] = [];
  for (const m of table[1].matchAll(/tokens:\s*\[([^\]]*)\]/g)) {
    for (const t of m[1].matchAll(/'([^']+)'/g)) tokens.push(t[1]);
  }
  return tokens;
}

/** Provider ids and API kinds: identifiers that share a family prefix but name no model. */
function readNonModelIdentifiers(): string[] {
  const ids = new Set<string>([...Object.keys(PROVIDER_MAP), ...PI_BUILTIN_PROVIDER_IDS]);
  for (const def of Object.values(PROVIDER_MAP)) if (def.api) ids.add(def.api);
  return [...ids];
}

const FAMILY_TOKENS = readFamilyTokens();
const NON_MODEL_IDENTIFIERS = readNonModelIdentifiers();
const scan = (text: string, file = 'src/fixture.ts') =>
  scanSourceText(text, { file, familyTokens: FAMILY_TOKENS, nonModelIdentifiers: NON_MODEL_IDENTIFIERS });
const literals = (text: string) => scan(text).map((f) => f.literal);

describe('readFamilyTokens() reads the real model-matcher table', () => {
  it('finds the documented families', () => {
    expect(FAMILY_TOKENS).toEqual(expect.arrayContaining(['claude', 'mistral', 'gemma', 'qwen', 'glm', 'nvidia']));
  });
});

describe('scanSourceText()', () => {
  it('reports a bare family-prefixed model id with its line', () => {
    const findings = scan(`const a = 1;\nconst M = 'gemma9-nonexistent:12b';\n`);
    expect(findings).toEqual([{ file: 'src/fixture.ts', literal: 'gemma9-nonexistent:12b', line: 2 }]);
  });

  it('reports provider/model refs, including inside template expressions', () => {
    const text = 'const s = `x ${pick(cfg.m, \'ollama/foo-model:7b\')} y`;\nconst r = "openrouter/acme/tiny-1:free";';
    expect(literals(text)).toEqual(['ollama/foo-model:7b', 'openrouter/acme/tiny-1:free']);
  });

  it('reports family ids embedded in a longer string', () => {
    expect(literals(`log('try qwen3.5:9b first');`)).toEqual(['qwen3.5:9b']);
  });

  it('reports model ids inside regex-literal bodies (rank/select tables)', () => {
    expect(literals(`const R = [/gemma4:12b|llama-3\\.1/i];`)).toEqual(['gemma4:12b', 'llama-3']);
  });

  it('ignores line comments, block comments and JSDoc', () => {
    const text = [
      '// prefer ollama/gemma2:2b here',
      '/* mistral-nemo:latest */',
      '/** e.g. "claude-sonnet-5" */',
      'const x = 1; // trailing gemma2:2b',
    ].join('\n');
    expect(scan(text)).toEqual([]);
  });

  it('ignores bare family tokens, prose and provider/API identifiers', () => {
    const text = [
      `const p = 'mistral';`,
      `const q = 'nemotron';`,
      `const msg = 'use gemini or gpt for this';`,
      `const prov = 'mistral-zai';`,
      `const api = 'openai-completions';`,
    ].join('\n');
    expect(scan(text)).toEqual([]);
  });

  it('ignores non-model slash strings (mime types, package names, URLs, paths)', () => {
    const text = [
      `const a = 'application/json';`,
      `const b = '@earendil-works/pi-ai';`,
      `const c = 'https://openrouter.ai/api/v1/models';`,
      `const d = 'offset/limit';`,
      `const e = \`\${provider}/\${id}\`;`,
      `const f = 'ollama/';`,
    ].join('\n');
    expect(scan(text)).toEqual([]);
  });
});

describe('scanConfig() — named-model positions in the shipped config', () => {
  const cfg = {
    log_level: 'warn',
    non_agent_model_prefixes: ['acme-small-'],
    exclude: { providers: ['someprov'], models: ['openrouter/acme/bad:free'], paid_models_from: ['openrouter'] },
    providers: {
      openrouter: { billing: 'pay_per_token', free_models: ['openrouter/acme/tiny-1:free'] },
      'claude-bridge': { billing: 'subscription' },
    },
    model_groups: {
      simple: { method: 'tiered', max_cost: 0, models: ['acme/pinned-1'], exclude_models: ['acme/never-1'] },
      dynamic: {
        method: 'dynamic',
        classifier_model: 'ollama/judge:1b',
        classifier_fallback: 'ollama/judge:0.5b',
        classifier_cloud_model: 'acme/cloud-judge',
        classifier_cloud_fallback: true,
      },
    },
    model_metrics: { 'claude-bridge/acme-5': { cost_per_m: 0.000001 } },
    gdpval_builtin: { 'acme-5': 1500 },
  };

  it('reports every named-model position with a config:<path> literal', () => {
    expect(scanConfig(cfg).map((f) => f.literal).sort()).toEqual(
      [
        'config:non_agent_model_prefixes[]=acme-small-',
        'config:exclude.models[]=openrouter/acme/bad:free',
        'config:providers.openrouter.free_models[]=openrouter/acme/tiny-1:free',
        'config:model_groups.simple.models[]=acme/pinned-1',
        'config:model_groups.simple.exclude_models[]=acme/never-1',
        'config:model_groups.dynamic.classifier_model=ollama/judge:1b',
        'config:model_groups.dynamic.classifier_fallback=ollama/judge:0.5b',
        'config:model_groups.dynamic.classifier_cloud_model=acme/cloud-judge',
        'config:model_metrics["claude-bridge/acme-5"]',
      ].sort()
    );
    expect(scanConfig(cfg).every((f) => f.file === 'router-config.json' && f.line === 0)).toBe(true);
  });

  it('does not report gdpval_builtin (class B annotation data) or provider-level entries', () => {
    const literals = scanConfig(cfg).map((f) => f.literal).join('\n');
    expect(literals).not.toContain('gdpval_builtin');
    expect(literals).not.toContain('exclude.providers');
    expect(literals).not.toContain('paid_models_from');
  });

  it('tolerates missing sections and non-object input', () => {
    expect(scanConfig({})).toEqual([]);
    expect(scanConfig(null)).toEqual([]);
    expect(scanConfig({ model_groups: { x: null }, providers: { y: 'z' }, exclude: [] })).toEqual([]);
  });
});

describe('compareToBaseline() — the ratchet', () => {
  const finding = (literal: string, line = 7): HardcodedFinding => ({ file: 'src/fixture.ts', literal, line });

  it('flags a literal that is not in the baseline, naming file, line and literal', () => {
    const findings = scan(`\n\nconst M = 'gemma9-nonexistent:12b';`);
    const violations = compareToBaseline(findings, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^NEW hardcoded model literal in src\/fixture\.ts:3: 'gemma9-nonexistent:12b'/);
    expect(violations[0]).toContain('ADR-0025');
  });

  it('flags a baseline entry that no longer matches any finding (stale)', () => {
    const stale: BaselineEntry = { file: 'src/fixture.ts', literal: 'gone-model:1b', count: 1 };
    const violations = compareToBaseline([], [stale]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^BASELINE entry is stale and must be REMOVED \(the ratchet only shrinks\)/);
    expect(violations[0]).toContain('gone-model:1b');
  });

  it('counts occurrences: a second copy of a baselined literal is new, a removed copy is stale', () => {
    const entry: BaselineEntry = { file: 'src/fixture.ts', literal: 'gemma2:2b', count: 1 };
    expect(compareToBaseline([finding('gemma2:2b', 3), finding('gemma2:2b', 9)], [entry])).toEqual([
      expect.stringMatching(/^NEW hardcoded model literal in src\/fixture\.ts:3,9: 'gemma2:2b' \(2 found, baseline allows 1\)/),
    ]);
    expect(compareToBaseline([finding('gemma2:2b')], [{ ...entry, count: 2 }])).toEqual([
      expect.stringMatching(/^BASELINE entry is stale and must be REMOVED .*now found 1/),
    ]);
  });

  it('passes when findings and baseline match exactly', () => {
    const findings = [finding('gemma2:2b', 3), finding('gemma2:2b', 9), finding('ollama/x-1:1b', 4)];
    expect(compareToBaseline(findings, toBaselineEntries(findings))).toEqual([]);
  });

  it('toBaselineEntries() aggregates per (file, literal) and sorts deterministically', () => {
    const entries = toBaselineEntries([
      { file: 'src/b.ts', literal: 'qwen3:4b', line: 1 },
      { file: 'src/a.ts', literal: 'zz-gemma2:2b', line: 5 },
      { file: 'src/a.ts', literal: 'gemma2:2b', line: 9 },
      { file: 'src/a.ts', literal: 'gemma2:2b', line: 2 },
    ]);
    expect(entries).toEqual([
      { file: 'src/a.ts', literal: 'gemma2:2b', count: 2 },
      { file: 'src/a.ts', literal: 'zz-gemma2:2b', count: 1 },
      { file: 'src/b.ts', literal: 'qwen3:4b', count: 1 },
    ]);
  });
});

/** Every finding in the shipped tree: scanned src/** + index.ts, plus the shipped config. */
function scanShippedTree(): HardcodedFinding[] {
  const sources = (readdirSync(path.join(REPO_ROOT, 'src'), { recursive: true }) as string[])
    .map((p) => `src/${p.split(path.sep).join('/')}`)
    .concat('index.ts')
    .filter(isScannedSourcePath)
    .sort();
  const findings = sources.flatMap((file) => scan(readFileSync(path.join(REPO_ROOT, file), 'utf-8'), file));
  const cfg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'router-config.json'), 'utf-8'));
  return findings.concat(scanConfig(cfg));
}

describe('ADR-0025 guard: no new hardcoded models in shipped source or config', () => {
  const baseline = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'scripts/hardcoded-model-baseline.json'), 'utf-8')
  ) as { note: string; entries: BaselineEntry[] };

  it('every finding is in the baseline and every baseline entry is still found', () => {
    const violations = compareToBaseline(scanShippedTree(), baseline.entries);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the baseline is canonical: sorted, one entry per (file, literal), positive counts', () => {
    const expanded: HardcodedFinding[] = baseline.entries.flatMap((e) =>
      Array.from({ length: e.count }, () => ({ file: e.file, literal: e.literal, line: 0 }))
    );
    expect(baseline.entries).toEqual(toBaselineEntries(expanded));
    expect(baseline.entries.every((e) => Number.isInteger(e.count) && e.count > 0)).toBe(true);
  });
});

describe('isScannedSourcePath() — ADR-0025 class A/B allowlist', () => {
  it('scans src/** and the root index.ts', () => {
    expect(isScannedSourcePath('src/routing.ts')).toBe(true);
    expect(isScannedSourcePath('src/content-classifier.ts')).toBe(true);
    expect(isScannedSourcePath('index.ts')).toBe(true);
  });

  it('skips the class A/B files', () => {
    for (const f of ['src/capabilities.ts', 'src/providers.ts', 'src/ollama-gdpval.ts', 'src/model-matcher.ts']) {
      expect(isScannedSourcePath(f)).toBe(false);
    }
  });

  it('skips tests, scripts and non-TypeScript files', () => {
    expect(isScannedSourcePath('test/routing.test.ts')).toBe(false);
    expect(isScannedSourcePath('scripts/scan-hardcoded-models.ts')).toBe(false);
    expect(isScannedSourcePath('src/notes.md')).toBe(false);
  });
});
