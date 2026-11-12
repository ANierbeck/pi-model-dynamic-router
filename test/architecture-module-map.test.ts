// test/architecture-module-map.test.ts
// Regression guard for the post-1.6.1 audit: docs/architecture.md described
// 33 of the 73 src/ modules, so a reader had no map for the Laya installer,
// the breaker, the delegation or the compaction modules. The module map must
// name every src/*.ts file as a backticked path, so adding a module without
// documenting it fails the suite (the ratchet only goes one way).

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');

describe('docs/architecture.md module map', () => {
  it('names every src/*.ts module (path or bare file name in backticks)', () => {
    const doc = fs.readFileSync(path.join(repoRoot, 'docs', 'architecture.md'), 'utf8');
    const modules = fs
      .readdirSync(path.join(repoRoot, 'src'))
      .filter((f) => f.endsWith('.ts'))
      .sort();
    expect(modules.length).toBeGreaterThan(50);

    // A module counts as named when its path or its bare file name is backticked.
    const missing = modules.filter(
      (m) => !doc.includes(`\`src/${m}\``) && !doc.includes(`\`${m}\``)
    );
    expect(missing).toEqual([]);
  });
});
