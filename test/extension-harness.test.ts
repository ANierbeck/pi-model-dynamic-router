// parkStateFiles must fail loudly when an existing state file cannot be
// parked: a swallowed rename failure lets the test run against the previous
// test's dynamic config / scan cache and pass for the wrong reason (PR #87
// review round, Sourcery finding).

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parkStateFiles } from './helpers/extension-harness.ts';

let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function tmp(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'park-state-'));
  return dir;
}

describe('parkStateFiles', () => {
  it('parks existing files, ignores missing ones and restores both on demand', () => {
    const d = tmp();
    const a = path.join(d, 'a.json');
    fs.writeFileSync(a, 'A');
    const restore = parkStateFiles([a, path.join(d, 'missing.json'), undefined, null]);
    expect(fs.existsSync(a)).toBe(false);
    restore();
    expect(fs.readFileSync(a, 'utf8')).toBe('A');
  });

  it('throws when an existing file cannot be parked, and restores what it already parked', () => {
    const d = tmp();
    const ok = path.join(d, 'ok.json');
    const stuck = path.join(d, 'stuck.json');
    fs.writeFileSync(ok, 'OK');
    fs.writeFileSync(stuck, 'STUCK');
    // A directory squatting on the backup name makes the rename fail (EISDIR).
    fs.mkdirSync(`${stuck}.test-park`);

    expect(() => parkStateFiles([ok, stuck])).toThrow(/stuck\.json/);
    // The first file was parked before the failure: it must be back in place.
    expect(fs.readFileSync(ok, 'utf8')).toBe('OK');
    expect(fs.readFileSync(stuck, 'utf8')).toBe('STUCK');
  });

  it('a failing restore is reported (not silent) and does not stop the other files from coming back', () => {
    const d = tmp();
    const a = path.join(d, 'a.json');
    const b = path.join(d, 'b.json');
    fs.writeFileSync(a, 'A');
    fs.writeFileSync(b, 'B');
    const restore = parkStateFiles([a, b]);
    // Something re-created `a` as a non-empty directory while it was parked: renaming the backup over it fails.
    fs.mkdirSync(a);
    fs.writeFileSync(path.join(a, 'blocker'), 'x');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      restore();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('a.json');
      expect(fs.readFileSync(b, 'utf8')).toBe('B'); // the second file was still restored
    } finally {
      warn.mockRestore();
    }
  });
});
