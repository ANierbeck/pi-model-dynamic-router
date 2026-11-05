// Guard: the package must not promise a lower Node floor than the Pi host it
// is loaded into. The 1.5.0 host requires node >=22.19.0 while this package
// still said >=20.11.0 — users on Node 20/21 would pass npm's engines check
// for the extension and then fail inside the host. Host upgrades are
// deliberate rounds (AGENTS.md section 10); this test makes the floor follow
// the host instead of drifting silently.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readJson = (rel: string) =>
  JSON.parse(readFileSync(join(process.cwd(), rel), 'utf8')) as {
    engines?: { node?: string };
  };

/**
 * `>=22.19.0` -> [22, 19, 0]. A missing or unparseable range is a test
 * failure, not a guess. `strict` (our own package.json) demands exactly a plain
 * floor; the host side may carry an upper bound (">=22.19.0 <25"), so only its
 * first ">=" bound is read.
 */
function floorOf(
  range: string | undefined,
  who: string,
  strict: boolean
): [number, number, number] {
  const m = (strict ? /^>=\s*(\d+)\.(\d+)\.(\d+)$/ : />=\s*(\d+)\.(\d+)\.(\d+)/).exec(range ?? '');
  if (!m) {
    throw new Error(
      `${who}: engines.node must ${strict ? 'be a plain ">=X.Y.Z" floor' : 'contain a ">=X.Y.Z" bound'}, got ${JSON.stringify(range)}`
    );
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const atLeast = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

describe('Node engines floor follows the Pi host', () => {
  it("package.json engines.node is at least the host's engines.node", () => {
    const own = floorOf(readJson('package.json').engines?.node, 'package.json', true);
    const host = floorOf(
      readJson('node_modules/@earendil-works/pi-coding-agent/package.json').engines?.node,
      'pi-coding-agent',
      false
    );
    expect(
      atLeast(own, host),
      `package.json promises node >=${own.join('.')} but the host needs >=${host.join('.')}`
    ).toBe(true);
  });
});
