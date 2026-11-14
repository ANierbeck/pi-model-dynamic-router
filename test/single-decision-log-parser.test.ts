// There is exactly one parser for the classifier decision log's JSONL lines
// (owner decision 2026-11-14: one code to maintain). The writer's module owns
// it; the script reader and the /router classifier summary call it.
// Source-text pin, like fallback-naming: a second JSON.parse loop over the log
// in any of these files fails the suite.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = join(__dirname, '..');
const READERS = [
  'src/classifier-decision-log.ts',
  'scripts/lib/decision-log.ts',
  'src/classifier-summary.ts',
];

describe('one decision-log line parser', () => {
  it('only src/classifier-decision-log.ts calls JSON.parse on decision-log lines', () => {
    const withParse = READERS.filter((f) =>
      readFileSync(join(ROOT, f), 'utf8').includes('JSON.parse(')
    );
    expect(withParse).toEqual(['src/classifier-decision-log.ts']);
  });

  it('the script reader and the summary both use the shared parser', () => {
    for (const f of ['scripts/lib/decision-log.ts', 'src/classifier-summary.ts']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).toMatch(/parseDecisionLogText\(/);
    }
  });
});
