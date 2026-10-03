// scripts/forbidden-patterns.ts
// The ONE list of strings that must never enter this public repository:
// references to the owner's other projects and private infrastructure
// (owner rule 2026-10-03). Shared by the tree guard
// (test/no-external-references.test.ts, checks HEAD) and the commit-range
// scan (scripts/secret-scan.ts, checks every added line of every pushed or
// merged commit). Generic credentials (API keys, tokens) are gitleaks' job.
//
// The patterns are assembled from fragments so this file does not match
// itself.

export interface ForbiddenPattern {
  name: string;
  re: RegExp;
}

export const FORBIDDEN: readonly ForbiddenPattern[] = [
  { name: 'absolute home path', re: new RegExp(['/Users', '/[a-z]'].join('')) },
  { name: 'tailnet hostname', re: new RegExp(['\\.ts', '\\.net\\b'].join('')) },
  { name: 'webhook URL', re: new RegExp(['/api', '/webhook/'].join('')) },
  { name: 'sibling private project', re: new RegExp(['private', '-chat'].join(''), 'i') },
  { name: 'sibling project (test bed)', re: new RegExp(['source', 'lume'].join(''), 'i') },
];

/** Generated/vendored files that legitimately carry third-party metadata. */
export const SKIP_PATHS: ReadonlySet<string> = new Set(['package-lock.json']);
