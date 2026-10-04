// Guard: no test file binds the same import name twice.
//
// tsconfig.json excludes test/** from `tsc --noEmit`, and vitest's
// transform tolerates a re-declared import binding — so duplicate imports
// left behind by the PR #16 consolidation (one file imported
// flushBackgroundScan three times and describe/it/expect five times) went
// unnoticed until Stryker's Babel parser rejected the file with
// "Identifier 'flushBackgroundScan' has already been declared". In strict
// ESM a duplicate binding is a SyntaxError, so any spec-compliant tool can
// choke on these files. Uses the TypeScript parser (already a devDependency)
// instead of regexes so multi-line and `import type` statements count too.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));

function listTestFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listTestFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Names that are bound more than once by the file's import declarations. */
export function duplicateImportBindings(source: string, fileName = 'file.ts'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const seen = new Set<string>();
  const dups = new Set<string>();
  const bind = (name: string) => (seen.has(name) ? dups.add(name) : seen.add(name));
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const clause = stmt.importClause;
    if (clause.name) bind(clause.name.text);
    const named = clause.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) bind(named.name.text);
    else for (const el of named.elements) bind(el.name.text);
  }
  return [...dups].sort();
}

describe('no duplicate import bindings in test files', () => {
  it('the detector itself flags a duplicate across separate statements', () => {
    // Guards the guard: a detector that never fires would make the
    // suite-wide check below vacuously green.
    const src = [
      "import { a, b } from './x';",
      "import type { C } from './y';",
      'import {',
      '  a,',
      '} from \'./x\';',
      "import type { C } from './z';",
    ].join('\n');
    expect(duplicateImportBindings(src)).toEqual(['C', 'a']);
    expect(duplicateImportBindings("import { a } from './x';\nimport { b } from './x';")).toEqual([]);
  });

  it('every test file binds each imported name exactly once', () => {
    const offenders: Record<string, string[]> = {};
    for (const file of listTestFiles(testDir)) {
      const dups = duplicateImportBindings(fs.readFileSync(file, 'utf8'), file);
      if (dups.length) offenders[path.relative(testDir, file)] = dups;
    }
    expect(offenders).toEqual({});
  });
});
