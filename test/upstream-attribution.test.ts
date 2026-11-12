import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

// Files that still carry code of the upstream pi-model-router keep its copyright
// notice (MIT); every other file is Achim Nierbeck's alone. The list lives in
// docs/upstream-attribution.md, measured in docs/research/2026-11-12-fork-remainder-measurement.md.
const LIST_RE = /<!-- upstream-files:start -->([\s\S]*?)<!-- upstream-files:end -->/;

function listedFiles(): string[] {
  const m = LIST_RE.exec(read('docs/upstream-attribution.md'));
  if (!m) return [];
  return [...m[1].matchAll(/^- `([^`]+)`/gm)].map((x) => x[1]);
}

describe('upstream attribution', () => {
  it('lists the files that still contain upstream code, and every entry exists', () => {
    const files = listedFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(existsSync(join(root, f)), f).toBe(true);
    expect(new Set(files).size).toBe(files.length);
  });

  it('LICENSE names the owner alone for the general case and both holders for the listed files', () => {
    const lic = read('LICENSE');
    const [general, listed] = lic.split(/Files listed in docs\/upstream-attribution\.md/);
    expect(listed, 'LICENSE must have the listed-files clause').toBeDefined();
    expect(general).toContain('Copyright (c) 2026 Achim Nierbeck');
    expect(general).not.toContain('a-canary');
    expect(listed).toContain('Copyright (c) 2026 a-canary');
    expect(listed).toContain('Copyright (c) 2026 Achim Nierbeck');
    expect(lic).toContain('Permission is hereby granted');
  });

  it('files that are not on the list are not claimed for the upstream holder', () => {
    const files = new Set(listedFiles());
    // Controls: written entirely after the fork (measured at <= 0.4 % shared tokens).
    for (const f of ['src/provider-breaker.ts', 'src/laya-classifier.ts', 'src/turn-state.ts']) {
      expect(files.has(f), f).toBe(false);
    }
  });
});
