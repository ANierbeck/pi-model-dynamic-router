// Phase 5 of the config plan (docs/plans/2026-11-14-config-surface-and-ui.md):
// docs/config-reference.md is generated from the key table
// (src/config-keys.ts) and a test fails when the committed file is stale —
// the same pattern as the lint baseline. The prose documents keep the
// concepts and link to the reference instead of hand-writing key tables, and
// the routing-flow diagram pins its node names to the chain steps
// describeClassifierChain emits.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_KEYS } from '../src/config-keys.ts';
import { describeClassifierChain } from '../src/classifier-chain.ts';
import type { Config } from '../src/types.ts';
import { renderConfigReference } from '../scripts/config-reference.ts';

const shipped = JSON.parse(
  fs.readFileSync(new URL('../router-config.json', import.meta.url), 'utf-8')
) as Config;

const read = (p: string): string => fs.readFileSync(new URL(p, import.meta.url), 'utf-8');

const PROSE_DOCS = [
  '../README.md',
  '../PI.md',
  '../docs/config-override.md',
  '../docs/routing-flow.md',
];

/** Further docs that describe the classifier; they must not name removed keys either. */
const SKILL_DOCS = fs
  .readdirSync(new URL('../skills/', import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `../skills/${d.name}/SKILL.md`);
const KEY_CHECKED_DOCS = [...PROSE_DOCS, '../docs/architecture.md', ...SKILL_DOCS];

const REFERENCE = fileURLToPath(new URL('../docs/config-reference.md', import.meta.url));

/** Key names the 2.0 block layout removed; the reference owns them (legacy column). */
const REMOVED_KEYS = [
  'classifier_cloud_chain',
  'classifier_cloud_model',
  'classifier_cloud_candidates',
  'classifier_escalate_low_confidence',
  'classifier_model',
  'classifier_fallback',
  'classifier_log',
];

describe('docs/config-reference.md — generated from the key table', () => {
  it('is committed and current (stale check)', () => {
    expect(read('../docs/config-reference.md')).toBe(renderConfigReference(shipped));
  });

  it('documents every table key with its path and meaning', () => {
    const doc = read('../docs/config-reference.md');
    for (const key of CONFIG_KEYS) {
      expect(doc, key.path).toContain(`\`${key.path}\``);
      expect(doc, key.path).toContain(key.meaning);
    }
  });

  it('marks every key the shipped file does not set as a code default, and shows the shipped value otherwise', () => {
    for (const key of CONFIG_KEYS) {
      let value: unknown = shipped;
      for (const part of key.path.split('.')) {
        value =
          value !== null && typeof value === 'object'
            ? (value as Record<string, unknown>)[part]
            : undefined;
      }
      if (value === undefined) {
        expect(key.shipped, key.path).toMatch(/ \(code default\)$/);
      } else {
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        expect(key.shipped.startsWith(rendered), key.path).toBe(true);
        expect(key.shipped, key.path).not.toMatch(/ \(code default\)$/);
      }
    }
  });

  it('shows the chain steps in the order the router runs them', () => {
    // The runtime order of classifyPrompt (src/content-classifier.ts), pinned as
    // a literal: describeClassifierChain also renders the doc, so its own order
    // cannot be the expectation.
    expect(describeClassifierChain(shipped).map((step) => step.id)).toEqual([
      'laya',
      'ollama',
      'cloud',
      'static',
    ]);
    const doc = read('../docs/config-reference.md');
    // The bold step label of the chain list; a bare label also occurs in prose.
    const positions = describeClassifierChain(shipped).map((step) =>
      doc.indexOf(`**${step.label}**`)
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('prose docs — concepts stay, keys link to the reference', () => {
  it.each(KEY_CHECKED_DOCS)('%s names no removed pre-2.0 classifier key', (p) => {
    const doc = read(p);
    for (const name of REMOVED_KEYS) {
      expect(doc.includes(name), `${p} still names ${name}`).toBe(false);
    }
  });

  it('docs/architecture.md does not say the shipped dynamic group turns the cloud leg on', () => {
    // The switch moved to the classifier block of router-config.json; `dynamic`
    // is still a group name, so the removed-key list cannot catch this phrase.
    const doc = read('../docs/architecture.md').replace(/\s+/g, ' ');
    expect(doc).not.toContain('the shipped `dynamic` group turns');
  });

  it.each(PROSE_DOCS)('%s links to the reference', (p) => {
    // A markdown link whose target, resolved from the doc's own directory,
    // is the reference file — a backticked path or a wrong relative path fails.
    const dir = path.dirname(fileURLToPath(new URL(p, import.meta.url)));
    const targets = [...read(p).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) =>
      path.resolve(dir, m[1])
    );
    expect(targets, p).toContain(REFERENCE);
  });
});

describe('docs/routing-flow.md — the diagram pins the chain step names', () => {
  it('defines a node for every step id describeClassifierChain emits', () => {
    const doc = read('../docs/routing-flow.md');
    for (const step of describeClassifierChain(shipped)) {
      // A node definition (`ID{…}` or `ID[…]`, at line start or after an edge
      // arrow), not a bare mention of the id.
      const node = new RegExp(`(^|\\s)${step.id.toUpperCase()}[\\[{(]`, 'm');
      expect(doc, step.id).toMatch(node);
    }
  });

  it('every chain step node has an incoming edge', () => {
    const doc = read('../docs/routing-flow.md');
    for (const step of describeClassifierChain(shipped)) {
      // `A --> ID`, `A -- "label" --> ID`, `A -. "label" .-> ID`.
      const incoming = new RegExp(`(-->|\\.->)\\s*${step.id.toUpperCase()}(?![A-Za-z0-9_])`);
      expect(doc, step.id).toMatch(incoming);
    }
  });
});
