// There is exactly one parser for the classifier decision log's JSONL lines
// (owner decision 2026-11-14: one code to maintain). The writer's module owns
// it; the script reader and the /router classifier summary call it.
// Source-text pin, like fallback-naming: a second JSON.parse loop over the log
// in any of these files fails the suite.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseDecisionLogText } from '../src/classifier-decision-log.ts';

const ROOT = join(__dirname, '..');
const WRITER = 'src/classifier-decision-log.ts';
// Every file that reads the decision log (the writer owns the parser).
const READERS = [
  WRITER,
  'scripts/lib/decision-log.ts',
  'src/classifier-summary.ts',
  'scripts/laya-e2e.ts',
];

describe('one decision-log line parser', () => {
  it('only src/classifier-decision-log.ts calls JSON.parse on decision-log lines', () => {
    const withParse = READERS.filter((f) =>
      readFileSync(join(ROOT, f), 'utf8').includes('JSON.parse(')
    );
    expect(withParse).toEqual(['src/classifier-decision-log.ts']);
  });

  it('the script reader, the summary and laya-e2e all use the shared parser', () => {
    for (const f of READERS.filter((f) => f !== WRITER)) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).toMatch(/parseDecisionLogText\(/);
    }
  });

  it('no other file runs its own line loop over a file that names the decision log', () => {
    // Tripwire: a script that mentions classifier-decisions.jsonl and parses it
    // line by line with its own JSON.parse(line) would be a second parser. The
    // two session-file readers below loop over session JSONL, not the decision log.
    const SESSION_LINE_LOOPS = ['scripts/turn-decision-join.ts', 'scripts/classifier-replay.ts'];
    const files = ['src', 'scripts'].flatMap((dir) =>
      (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `${dir}/${f}`)
    );
    const named = files.filter((f) =>
      readFileSync(join(ROOT, f), 'utf8').includes('classifier-decisions')
    );
    // The scan is only meaningful if it finds the known readers.
    expect(named).toContain('scripts/laya-e2e.ts');
    const ownLoops = named.filter(
      (f) => !READERS.includes(f) && readFileSync(join(ROOT, f), 'utf8').includes('JSON.parse(line')
    );
    expect(ownLoops.filter((f) => !SESSION_LINE_LOOPS.includes(f))).toEqual([]);
  });
});

// Characterization of the script-facing contract (no bounds: keep what parses).
// These pass on the shared parser by design; they pin behaviour the summary
// tests do not reach.
describe('parseDecisionLogText (script contract)', () => {
  const rec = (o: object): string => JSON.stringify(o);

  it('skips blank lines, torn lines and non-object lines', () => {
    const text = [
      '',
      '   ',
      rec({ ts: '2026-11-14T10:00:00.000Z', stage: 'hint' }),
      '{"ts": "2026-11-14T10:00',
      '42',
      'null',
      '[1,2]',
    ].join('\n');
    expect(parseDecisionLogText(text)).toEqual([{ ts: '2026-11-14T10:00:00.000Z', stage: 'hint' }]);
  });

  it('without bounds keeps records with an unparseable ts and records of any shape', () => {
    const text = [rec({ ts: 'garbage', stage: 'hint' }), rec({ stage: 7 })].join('\n');
    expect(parseDecisionLogText(text)).toEqual([{ ts: 'garbage', stage: 'hint' }, { stage: 7 }]);
  });

  it('with bounds skips records whose ts is unparseable and keeps the window', () => {
    const since = Date.parse('2026-11-14T00:00:00.000Z');
    const until = Date.parse('2026-11-15T00:00:00.000Z');
    const text = [
      rec({ ts: 'garbage', stage: 'a' }),
      rec({ ts: '2026-11-13T23:59:59.000Z', stage: 'before' }),
      rec({ ts: '2026-11-14T12:00:00.000Z', stage: 'inside' }),
      rec({ ts: '2026-11-15T00:00:01.000Z', stage: 'after' }),
    ].join('\n');
    expect(parseDecisionLogText(text, { since, until }).map((r) => r.stage)).toEqual(['inside']);
  });

  it('returns records in file order (oldest first, as the rotation reader concatenates them)', () => {
    const text = [
      rec({ ts: '2026-11-14T10:00:00.000Z', n: 1 }),
      rec({ ts: '2026-11-14T09:00:00.000Z', n: 2 }),
    ].join('\n');
    expect(parseDecisionLogText(text).map((r) => (r as { n: number }).n)).toEqual([1, 2]);
  });
});
