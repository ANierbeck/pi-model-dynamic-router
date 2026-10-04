/**
 * Boundary guard (ADR-0022, owner decision 2026-10-04: the router has no
 * business accessing Pi's credential store at all — that access is itself
 * the mistake).
 *
 * Pi owns credential resolution end-to-end (auth.json with !command values,
 * models.json, env, CLI OAuth — via modelRegistry.getApiKeyForProvider).
 * The router must never read or write Pi's credential store, and must not
 * keep its own parallel key-resolution machinery (which historically
 * duplicated pi's semantics and even WROTE refreshed tokens into auth.json).
 *
 * Static scan over src/ + index.ts: none of the removed machinery's
 * identifiers may reappear. Comments count too — a comment referencing the
 * machinery usually means half-removed code.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Every identifier of the removed key-resolution machinery. If one of these
// reappears in src/ or index.ts, the boundary is broken.
const FORBIDDEN_IN_SRC: { pattern: RegExp; why: string }[] = [
  { pattern: /auth\.json/, why: 'the router never reads or writes Pi credential stores' },
  { pattern: /__auth_json__/, why: 'auth.json marker resolution was removed (ADR-0022)' },
  { pattern: /__oauth__/, why: 'auth.json marker resolution was removed (ADR-0022)' },
  { pattern: /__cli_oauth__/, why: 'CLI auth file discovery was removed (ADR-0022)' },
  { pattern: /cliAuthFiles/, why: 'CLI auth file discovery was removed (ADR-0022)' },
  { pattern: /!pass show/, why: 'pass-store key commands are resolved by pi, not the router' },
  { pattern: /pass\s+ls/, why: 'pass-store discovery was removed (ADR-0022)' },
  { pattern: /parsePassTree/, why: 'pass-store discovery was removed (ADR-0022)' },
  { pattern: /passPatterns/, why: 'pass-store discovery was removed (ADR-0022)' },
  { pattern: /loadAuthFile|loadAuth\b|saveAuth/, why: 'the router never touches Pi credential stores' },
  { pattern: /authKey/, why: 'auth.json key routing was removed (ADR-0022)' },
  { pattern: /resolveKeyRef|resolveKeyValue/, why: 'parallel key resolution was removed; ask pi' },
  { pattern: /discoverKeys/, why: 'key discovery was removed; pi owns keys (ADR-0022)' },
  { pattern: /discoveredProviders/, why: 'key discovery was removed (ADR-0022)' },
  { pattern: /activeKeyIndex/, why: 'multi-key rotation was removed; one key per provider, from pi' },
  { pattern: /execSync/, why: 'the router no longer executes key commands (ADR-0022)' },
  { pattern: /child_process/, why: 'the router executes no commands for keys (ADR-0022)' },
  { pattern: /process\.env\.[A-Z_]*KEY/, why: 'the router reads no API keys from the environment (ADR-0022)' },
  { pattern: /envVar/, why: 'router-side env key discovery was removed (ADR-0022)' },
  { pattern: /modelsUrl|authHeader|modelFilter/, why: 'cloud catalog scanning was removed (ADR-0022/0021)' },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listSourceFiles(p));
    else if (ent.isFile() && ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('the router never touches auth.json or resolves keys itself (ADR-0022)', () => {
  const files = [...listSourceFiles(path.join(repoRoot, 'src')), path.join(repoRoot, 'index.ts')];

  it('scans a non-empty set of source files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const { pattern, why } of FORBIDDEN_IN_SRC) {
    it(`no src file matches /${pattern.source}/ (${why})`, () => {
      const offenders: string[] = [];
      for (const f of files) {
        const text = fs.readFileSync(f, 'utf-8');
        if (pattern.test(text)) offenders.push(path.relative(repoRoot, f));
      }
      expect(offenders, `pattern /${pattern.source}/ found in: ${offenders.join(', ')}`).toEqual([]);
    });
  }
});
