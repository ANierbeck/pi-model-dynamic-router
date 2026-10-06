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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROVIDER_MAP, PI_BUILTIN_PROVIDER_IDS } from '../src/providers.ts';
import { scanSourceText, isScannedSourcePath, scanConfig } from '../scripts/scan-hardcoded-models.ts';

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
