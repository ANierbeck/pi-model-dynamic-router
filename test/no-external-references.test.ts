/**
 * Guard: the public repo must not reference the owner's other projects or
 * private infrastructure (owner rule 2026-10-03: "references to sources
 * other than our own must disappear from the project").
 *
 * Found on 2026-10-03: a Home Assistant webhook URL (tailnet hostname plus
 * webhook id) in a migration runbook, pointers into a sibling private
 * project, and an absolute home-directory path. Live findings are cited as
 * "live session" / "live finding", never by project name or path.
 *
 * The patterns live in scripts/forbidden-patterns.ts (assembled from
 * fragments so no file matches itself).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN, SKIP_PATHS } from '../scripts/forbidden-patterns.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The pattern list is shared with the commit-range scan (scripts/secret-scan.ts),
// which closes this guard's blind spot: it only sees the tree at HEAD.
const SKIP = SKIP_PATHS;

describe('no references to external projects or private infrastructure', () => {
  it('no tracked file matches a forbidden pattern', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf-8' })
      .split('\0')
      .filter((f) => f && !SKIP.has(f));
    // Sanity: the scan must actually cover the repo (non-vacuous).
    expect(files.length).toBeGreaterThan(100);

    const hits: string[] = [];
    for (const rel of files) {
      const abs = path.join(repoRoot, rel);
      let text: string;
      try {
        if (!fs.statSync(abs).isFile()) continue;
        text = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue; // deleted in the working tree
      }
      text.split('\n').forEach((line, i) => {
        for (const { name, re } of FORBIDDEN) {
          if (re.test(line)) hits.push(`${rel}:${i + 1} [${name}] ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('the patterns themselves still detect what they guard against', () => {
    // Without this, a typo in a pattern would make the scan pass vacuously.
    const samples: Record<string, string> = {
      'absolute home path': 'read ' + '/Users' + '/someone/x',
      'tailnet hostname': 'http://host.tail' + 'net.ts' + '.net:8123',
      'webhook URL': 'http://h:8123/api' + '/webhook/abc',
      'sibling private project': '~/private' + '-chat session',
      'sibling project (test bed)': 'the source' + 'lume session',
    };
    for (const { name, re } of FORBIDDEN) expect(re.test(samples[name]), name).toBe(true);
  });
});
