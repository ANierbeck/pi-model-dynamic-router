// scripts/scan-hardcoded-models.ts
// ADR-0025 guard scanner: finds concrete model names in shipped source
// (string literals, template-literal text and regex-literal bodies) so
// test/no-hardcoded-models.test.ts can hold them against the ratcheting
// baseline in scripts/hardcoded-model-baseline.json.
//
// Pure module — no file-system access. The test reads the files and passes
// in the family-token list (src/model-matcher.ts) and the provider/API
// identifiers (src/providers.ts), so this file names no model or provider
// itself.

import ts from 'typescript';

export interface HardcodedFinding {
  file: string;
  literal: string;
  line: number;
}

export interface SourceScanOptions {
  /** Repo-relative path, reported verbatim in each finding. */
  file: string;
  /** Model-family tokens (src/model-matcher.ts MODEL_FAMILIES). */
  familyTokens: readonly string[];
  /**
   * Exact identifiers that share a family prefix but name no model — the
   * test derives them from PROVIDER_MAP keys, their `api` values and
   * PI_BUILTIN_PROVIDER_IDS (provider ids such as 'mistral-zai', API kinds
   * such as 'openai-completions'). Derived rather than hand-listed so a new
   * provider adapter never needs a scanner edit.
   */
  nonModelIdentifiers?: readonly string[];
}

/**
 * ADR-0025 class A (provider adapters) and class B (annotation tables that
 * only score/identify models Pi already supplied) — their literals are
 * allowed and not reported.
 */
export const ALLOWLISTED_SOURCE_FILES: ReadonlySet<string> = new Set([
  'src/capabilities.ts',
  'src/providers.ts',
  'src/ollama-gdpval.ts',
  'src/model-matcher.ts',
]);

/** Shipped source the guard scans: src/**.ts and the root index.ts, minus the class A/B allowlist. */
export function isScannedSourcePath(relPath: string): boolean {
  if (relPath === 'index.ts') return true;
  return relPath.startsWith('src/') && relPath.endsWith('.ts') && !ALLOWLISTED_SOURCE_FILES.has(relPath);
}

const ID_CHARS = 'A-Za-z0-9._:+-';
// A ref is `provider/model[/more]`; the lookbehind keeps URL and path
// segments (preceded by '/', '.', ':') from matching mid-string.
const REF_RE = new RegExp(`(?<![A-Za-z0-9_./:-])[a-z][a-z0-9-]*/[A-Za-z][${ID_CHARS}]*(?:/[A-Za-z0-9][${ID_CHARS}]*)*`, 'g');

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Trailing sentence punctuation is prose, not part of the id. */
function trimId(s: string): string {
  return s.replace(/[.:]+$/, '');
}

function findModelLiterals(text: string, opts: SourceScanOptions): string[] {
  const tokens = [...opts.familyTokens].map((t) => t.toLowerCase());
  const tokenSet = new Set(tokens);
  const exempt = new Set((opts.nonModelIdentifiers ?? []).map((s) => s.toLowerCase()));
  const found: string[] = [];

  // provider/model refs: the model part must look like an id (a family
  // token, a ':tag' or a digit), so 'application/json' or
  // '@scope/pkg-name' do not count.
  for (const m of text.matchAll(REF_RE)) {
    const ref = trimId(m[0]);
    const modelPart = ref.slice(ref.indexOf('/') + 1).toLowerCase();
    if (!modelPart) continue;
    const idShaped = /[:\d]/.test(modelPart) || tokens.some((t) => modelPart.includes(t));
    if (idShaped) found.push(ref);
  }

  // Bare family-prefixed ids: a family token followed by more id
  // characters ('gemma2:2b', 'mistral-small-'). A bare token ('mistral',
  // 'nemotron') is a provider/family name, not a model.
  if (tokens.length) {
    const alternation = [...tokens].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    const familyRe = new RegExp(`(?<![A-Za-z0-9_./-])(?:${alternation})[A-Za-z0-9._:-]+`, 'gi');
    for (const m of text.matchAll(familyRe)) {
      const id = trimId(m[0]);
      const lower = id.toLowerCase();
      if (tokenSet.has(lower) || exempt.has(lower)) continue;
      found.push(id);
    }
  }
  return found;
}

const SHIPPED_CONFIG_FILE = 'router-config.json';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * Reports the named-model positions of the shipped config structurally —
 * every one of them can admit, select, rank or exclude a model. Literals
 * are `config:<path>` plus the value, so removing one entry never renames
 * the others (index-free paths).
 *
 * `gdpval_builtin` is NOT reported: class B annotation data that only
 * scores models Pi already supplied (ADR-0025 §2).
 */
export function scanConfig(cfgJson: unknown): HardcodedFinding[] {
  if (!isRecord(cfgJson)) return [];
  const literals: string[] = [];
  const add = (literal: string) => literals.push(`config:${literal}`);

  for (const p of stringsOf(cfgJson.non_agent_model_prefixes)) add(`non_agent_model_prefixes[]=${p}`);

  if (isRecord(cfgJson.exclude)) {
    for (const m of stringsOf(cfgJson.exclude.models)) add(`exclude.models[]=${m}`);
  }

  if (isRecord(cfgJson.providers)) {
    for (const [prov, def] of Object.entries(cfgJson.providers)) {
      if (!isRecord(def)) continue;
      for (const m of stringsOf(def.free_models)) add(`providers.${prov}.free_models[]=${m}`);
    }
  }

  if (isRecord(cfgJson.model_groups)) {
    for (const [group, def] of Object.entries(cfgJson.model_groups)) {
      if (!isRecord(def)) continue;
      for (const m of stringsOf(def.models)) add(`model_groups.${group}.models[]=${m}`);
      for (const m of stringsOf(def.exclude_models)) add(`model_groups.${group}.exclude_models[]=${m}`);
      for (const key of ['classifier_model', 'classifier_fallback', 'classifier_cloud_model']) {
        const v = def[key];
        if (typeof v === 'string') add(`model_groups.${group}.${key}=${v}`);
      }
    }
  }

  if (isRecord(cfgJson.model_metrics)) {
    for (const ref of Object.keys(cfgJson.model_metrics)) add(`model_metrics[${JSON.stringify(ref)}]`);
  }

  return literals.map((literal) => ({ file: SHIPPED_CONFIG_FILE, literal, line: 0 }));
}

/**
 * Reports model-shaped literals in TypeScript source. Only string literals,
 * template-literal text and regex-literal bodies are inspected — comments
 * and identifiers never produce findings, because the TypeScript parser
 * separates them out.
 */
export function scanSourceText(text: string, opts: SourceScanOptions): HardcodedFinding[] {
  const sf = ts.createSourceFile(opts.file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: HardcodedFinding[] = [];
  const visit = (node: ts.Node): void => {
    let content: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)) {
      content = node.text;
    } else if (ts.isRegularExpressionLiteral(node)) {
      content = node.text.slice(1, node.text.lastIndexOf('/'));
    }
    if (content !== null) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      for (const literal of findModelLiterals(content, opts)) findings.push({ file: opts.file, literal, line });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}
