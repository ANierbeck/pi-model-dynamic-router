// Shared helpers for the analysis scripts
// (hygiene Phase 5 Step 3, docs/plans/2026-10-29-repo-hygiene.md).
//
// These five were re-declared in up to four scripts each. They are small, but
// they are also the kind of small that drifts: `arg` existed in two shapes
// (`--name=value` and `--name value`), so a flag that worked in one script was
// silently ignored in another. One implementation, both shapes.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * A CLI flag. Accepts both shapes this repo uses:
 *   --name=value   and   --name value
 * Returns undefined when the flag is absent. `argv` defaults to
 * process.argv.slice(2) so a test can pass its own.
 */
export function arg(name: string, argv: string[] = process.argv.slice(2)): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) return argv[i + 1];
  return undefined;
}

/**
 * True when the CALLING module is the entry point (not imported by a test).
 *
 * The caller must pass its own `import.meta.url`: inside this library module
 * `import.meta.url` is cli.ts's own URL, so a guard that read it here would be
 * false for every script — which is exactly what happened when the four
 * per-script copies moved here (caught by test/secret-scan.test.ts, whose
 * pre-push hook silently stopped rejecting leaks).
 */
export function invokedDirectly(moduleUrl: string): boolean {
  try {
    return !!process.argv[1] && moduleUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

/** 1-based line/column of a mutation report -> offset into the source text. */
export function offsetOf(source: string, line: number, column: number): number {
  const lines = source.split('\n');
  let off = 0;
  for (let i = 0; i < line - 1; i++) off += lines[i]!.length + 1;
  return off + column - 1;
}

/** `k` of `n` as a percentage with one decimal, or an en dash for n = 0. */
export function pct(k: number, n: number): string {
  return n ? `${((k / n) * 100).toFixed(1)} %` : '–';
}
