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
