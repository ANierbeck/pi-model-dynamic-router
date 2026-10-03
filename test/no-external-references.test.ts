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
 * The patterns are assembled from fragments so this file does not match
 * itself.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'absolute home path', re: new RegExp(['/Users', '/[a-z]'].join('')) },
  { name: 'tailnet hostname', re: new RegExp(['\\.ts', '\\.net\\b'].join('')) },
  { name: 'webhook URL', re: new RegExp(['/api', '/webhook/'].join('')) },
  { name: 'sibling private project', re: new RegExp(['private', '-chat'].join(''), 'i') },
  { name: 'sibling project (test bed)', re: new RegExp(['source', 'lume'].join(''), 'i') },
];

// Generated/vendored files that legitimately carry third-party metadata.
const SKIP = new Set(['package-lock.json']);

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
