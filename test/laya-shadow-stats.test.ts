// Replay of the Laya shadow decision-log statistics tool (scripts/laya-shadow-stats.ts).
// Synthetic records, no dependency on the real decision log.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAMPLE =
  '{"stage":"laya","final":{"category":"design"},"laya":{"category":"design","confidence":0.95,"acted":false,"ms":80}}\n' +
  '{"stage":"laya","final":{"category":"code_simple"},"laya":{"category":"code_complex","confidence":0.91,"acted":false,"ms":90},"input":{"text":{"prompt":"rename variable cnt to count"}}}\n' +
  '{"stage":"laya","final":{"category":"fallback"},"laya":{"category":"code_simple","confidence":0.45,"acted":false,"ms":15},"input":{"text":{"prompt":"please fix test"}}}\n' +
  '{"stage":"hint","final":{"hint":{"target":"strategic"}},"laya":{"category":"design","confidence":0.88,"acted":false,"ms":50},"input":{"text":{"prompt":"HINT: use group strategic"}}}\n' +
  '{"stage":"laya","final":{"category":"design"},"laya":{"category":"design","confidence":0.99,"acted":false,"ms":40}}\n' +
  '{"stage":"laya","final":{"category":"fallback"},"laya":{"category":"code_simple","confidence":0.35,"acted":false,"ms":18},"input":{"text":{"prompt":"how are you"}}}';

function run(args: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'laya-stats-'));
  const file = join(dir, 'log.jsonl');
  writeFileSync(file, SAMPLE);
  const out = spawnSync('npx', ['tsx', 'scripts/laya-shadow-stats.ts', `--file=${file}`, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });
  expect(out.status).toBe(0);
  return out.stdout;
}

describe('laya-shadow-stats', () => {
  it('reports agreement rate, confidence buckets and latency from synthetic records', () => {
    const out = run([]);
    expect(out).toContain('Laya shadow statistics');
    expect(out).toContain('Laya invocations across 6 classifications');
    expect(out).toContain('33.3 %');  // 2 agree of 6
    expect(out).toContain('66.7 %');  // 4 disagree of 6
    expect(out).toContain('would have decided): 4 of 6');
    expect(out).toContain('Avg confidence: agree 97.0 | disagree 64.8');
    expect(out).toContain('≥ 0.95=2 0.90-0.95=1 < 0.70=2 0.80-0.90=1');
    expect(out).toContain('avg 49 ms');
  });

  it('lists only real disagreements in the top-pairs matrix and shows the high-confidence prompt', () => {
    const out = run([]);
    // agreement pairs must not appear here
    expect(out).not.toContain('design → design');
    expect(out).not.toContain('code_simple → code_simple');
    // real high-confidence disagreements (sorted by count desc)
    expect(out).toContain('code_simple  → fallback 2');
    expect(out).toContain('code_complex → code_simple 1');
    expect(out).toContain('design       → strategic 1');
    expect(out).toContain('This is the raw material for the golden set (Task 7):');
    expect(out).toContain('rename variable cnt to count');
    expect(out).toContain('HINT: use group strategic');
  });

  it('handles an empty decision log gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'laya-stats-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, '');
    const out = spawnSync('npx', ['tsx', 'scripts/laya-shadow-stats.ts', `--file=${file}`], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    rmSync(dir, { recursive: true, force: true });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('(no Laya calls)');
  });

  it('exits 0 with a friendly hint when the log file does not exist', () => {
    const out = spawnSync('npx', ['tsx', 'scripts/laya-shadow-stats.ts', '--file=/tmp/nonexistent-laya-stats.jsonl'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('No decision log yet');
  });
});
