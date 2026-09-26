/**
 * Regression tests: Layer 1 escalation for expensive models (2026-09-26).
 *
 * ADR-0007 extension, user-requested: models in expensive groups
 * (default: strategic, tactical) or behind expensive provider prefixes
 * (default: none) must NEVER do full-file reads — they orchestrate and
 * reason; file inspection belongs to the cheap bulk_reader group. While
 * the size-based block (delegation.block_lines) protects against huge
 * corpora on every model, the expensive-model block fires for EVERY
 * full-file read (no offset/limit), regardless of file size, because:
 *   (a) every file-read token on a $2/$10 model is pure waste when the
 *       bulk_reader answers for $0, and
 *   (b) prompt evidence 2026-09-26: pi-claude sessions crash on file
 *       tool calls (kendex bridge ENOENT) — routing file inspection
 *       through bulk_read avoids the broken path entirely.
 *
 * Guard rails tested here:
 *   - targeted reads (offset/limit) are NEVER blocked (edit workflows
 *     need exact lines),
 *   - fail-open semantics: unknown model, missing group, stat errors,
 *     delegation disabled, block_lines 0 — everything passes,
 *   - Router.getCurModel(turnStartMs) stale guard: a stream ref from a
 *     PREVIOUS turn must not mark the current turn's model as expensive.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkReadBlock, isExpensiveModelRef, resolveReadBlockStreamRef } from '../src/bulk-read.ts';
import { delegationSettings } from '../src/delegation.ts';
import { Router } from '../src/routing.ts';
import type { Config } from '../src/types.ts';

// ── fixtures ────────────────────────────────────────────────────────────

let tmpDir: string;
let smallFile: string; // 20 lines, below every threshold
let largeFile: string; // 800 lines, above block_lines 350

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expensive-read-block-'));
  smallFile = path.join(tmpDir, 'small.ts');
  largeFile = path.join(tmpDir, 'large.ts');
  fs.writeFileSync(smallFile, Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join('\n'));
  fs.writeFileSync(largeFile, Array.from({ length: 800 }, (_, i) => `// line ${i + 1}`).join('\n'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Active-config shape as materialized by the scan (dynamic config):
 *  model_groups.<name>.models is a string[] of full refs. */
function makeCfg(overrides?: Record<string, unknown>): Config {
  const delegation: Record<string, unknown> = {
    enabled: true,
    block_lines: 350,
    ...overrides,
  };
  return {
    delegation,
    model_groups: {
      strategic: { models: ['mistral/zai-glm-5-3', 'pi-claude/claude-sonnet-5'] },
      tactical: { models: ['mistral/zai-glm-5-2'] },
      trivial: { models: ['ollama/qwen3.8:27b-mlx'] },
    },
  } as unknown as Config;
}

const EXPENSIVE_GROUP_MEMBER = 'mistral/zai-glm-5-3';
const CHEAP_LOCAL = 'ollama/qwen3.8:27b-mlx';
const CHEAP_FREE = 'openrouter/z-ai/glm-5.2:free';

// ── delegationSettings: expensive_groups / expensive_providers ───────────

describe('delegationSettings expensive-model fields', () => {
  it('defaults: expensive_groups strategic+tactical, expensive_providers empty', () => {
    const s = delegationSettings(makeCfg());
    expect(s.expensive_groups).to.deep.equal(['strategic', 'tactical']);
    expect(s.expensive_providers).to.deep.equal([]);
  });

  it('honors explicit overrides', () => {
    const s = delegationSettings(
      makeCfg({ expensive_groups: ['operational'], expensive_providers: ['pi-claude'] })
    );
    expect(s.expensive_groups).to.deep.equal(['operational']);
    expect(s.expensive_providers).to.deep.equal(['pi-claude']);
  });

  it('invalid lists (non-array / non-string entries) fall back to defaults whole-list', () => {
    const s1 = delegationSettings(makeCfg({ expensive_groups: 'strategic' }));
    expect(s1.expensive_groups).to.deep.equal(['strategic', 'tactical']);
    const s2 = delegationSettings(makeCfg({ expensive_providers: ['pi-claude', 42] }));
    expect(s2.expensive_providers).to.deep.equal([]);
  });
});

// ── isExpensiveModelRef ───────────────────────────────────────────────────

describe('isExpensiveModelRef', () => {
  const s = delegationSettings(makeCfg());

  it('matches a member of an expensive group (strategic)', () => {
    expect(isExpensiveModelRef(EXPENSIVE_GROUP_MEMBER, makeCfg(), s)).to.equal(true);
  });

  it('matches a member of a second expensive group (tactical)', () => {
    expect(isExpensiveModelRef('mistral/zai-glm-5-2', makeCfg(), s)).to.equal(true);
  });

  it('does not match members of non-expensive groups (trivial)', () => {
    expect(isExpensiveModelRef(CHEAP_LOCAL, makeCfg(), s)).to.equal(false);
  });

  it('does not match unknown refs', () => {
    expect(isExpensiveModelRef('unknown/model', makeCfg(), s)).to.equal(false);
    expect(isExpensiveModelRef('', makeCfg(), s)).to.equal(false);
  });

  it('provider prefix match: bare prefix and prefix-with-slash both hit', () => {
    const sp = delegationSettings(makeCfg({ expensive_providers: ['pi-claude'] }));
    const cfg = makeCfg();
    expect(isExpensiveModelRef('pi-claude/claude-sonnet-5', cfg, sp)).to.equal(true);
    expect(isExpensiveModelRef('pi-claude', cfg, sp)).to.equal(true);
    expect(isExpensiveModelRef('pi-claudefoo/bar', cfg, sp)).to.equal(false);
  });

  it('fail-open: missing group key or missing models array → false', () => {
    const cfg = { model_groups: { strategic: {} } } as unknown as Config;
    expect(isExpensiveModelRef(EXPENSIVE_GROUP_MEMBER, cfg, s)).to.equal(false);
    expect(isExpensiveModelRef(EXPENSIVE_GROUP_MEMBER, undefined, s)).to.equal(false);
  });

  it('defensive: group entries as { ref } objects are matched too', () => {
    const cfg = {
      model_groups: { strategic: { models: [{ ref: 'mistral/zai-glm-5-3' }] } },
    } as unknown as Config;
    expect(isExpensiveModelRef(EXPENSIVE_GROUP_MEMBER, cfg, s)).to.equal(true);
  });
});

// ── checkReadBlock with curModel ───────────────────────────────────────────

describe('checkReadBlock expensive-model escalation', () => {
  it('blocks EVERY full-file read for an expensive model, even a 20-line file', () => {
    const out = checkReadBlock(
      { toolName: 'read', input: { path: smallFile } },
      makeCfg(),
      EXPENSIVE_GROUP_MEMBER
    );
    expect(out?.block).to.equal(true);
    expect(out?.reason).to.include('expensive');
    expect(out?.reason).to.include('bulk_read');
  });

  it('marks expensive blocks with expensive:true for logging', () => {
    const out = checkReadBlock(
      { toolName: 'read', input: { path: smallFile } },
      makeCfg(),
      EXPENSIVE_GROUP_MEMBER
    );
    expect((out as any)?.expensive).to.equal(true);
  });

  it('targeted reads pass for expensive models (offset/limit)', () => {
    const withOffset = checkReadBlock(
      { toolName: 'read', input: { path: largeFile, offset: 1, limit: 10 } },
      makeCfg(),
      EXPENSIVE_GROUP_MEMBER
    );
    expect(withOffset).to.equal(undefined);
    const withLimitOnly = checkReadBlock(
      { toolName: 'read', input: { path: largeFile, limit: 50 } },
      makeCfg(),
      EXPENSIVE_GROUP_MEMBER
    );
    expect(withLimitOnly).to.equal(undefined);
  });

  it('cheap models keep the size-only behavior: small file passes', () => {
    const out = checkReadBlock({ toolName: 'read', input: { path: smallFile } }, makeCfg(), CHEAP_LOCAL);
    expect(out).to.equal(undefined);
    expect(checkReadBlock({ toolName: 'read', input: { path: smallFile } }, makeCfg(), CHEAP_FREE)).to.equal(
      undefined
    );
  });

  it('cheap models still get size-blocked on large files (regression guard)', () => {
    const out = checkReadBlock({ toolName: 'read', input: { path: largeFile } }, makeCfg(), CHEAP_LOCAL);
    expect(out?.block).to.equal(true);
    expect((out as any)?.expensive).to.not.equal(true);
    expect(out?.reason).to.include('block threshold');
  });

  it('unknown / empty curModel falls back to size-only blocking (fail-open)', () => {
    expect(checkReadBlock({ toolName: 'read', input: { path: smallFile } }, makeCfg(), undefined)).to.equal(
      undefined
    );
    expect(checkReadBlock({ toolName: 'read', input: { path: smallFile } }, makeCfg(), '')).to.equal(
      undefined
    );
  });

  it('non-read tools pass even for expensive models (bash is Layer 3 territory)', () => {
    const out = checkReadBlock({ toolName: 'bash', input: { command: 'cat x' } }, makeCfg(), EXPENSIVE_GROUP_MEMBER);
    expect(out).to.equal(undefined);
  });

  it('delegation disabled → expensive model passes (fail-open)', () => {
    const out = checkReadBlock(
      { toolName: 'read', input: { path: smallFile } },
      makeCfg({ enabled: false }),
      EXPENSIVE_GROUP_MEMBER
    );
    expect(out).to.equal(undefined);
  });

  it('block_lines 0 disables pre-call blocking entirely, including expensive blocks', () => {
    const out = checkReadBlock(
      { toolName: 'read', input: { path: largeFile } },
      makeCfg({ block_lines: 0 }),
      EXPENSIVE_GROUP_MEMBER
    );
    expect(out).to.equal(undefined);
  });

  it('nonexistent file passes even for expensive models (the read tool reports it)', () => {
    const out = checkReadBlock(
      { toolName: 'read', input: { path: path.join(tmpDir, 'does-not-exist.ts') } },
      makeCfg(),
      EXPENSIVE_GROUP_MEMBER
    );
    expect(out).to.equal(undefined);
  });
});

// ── Router.getCurModel stale guard ─────────────────────────────────────────

describe('Router.getCurModel stale guard', () => {
  const mkRouter = () => new Router(makeCfg(), {} as never, new Map() as never);

  it('empty before any stream selected a model', () => {
    const r = mkRouter();
    expect(r.getCurModel(1000)).to.equal('');
  });

  it('returns the stream ref when it was set AFTER the current turn started', () => {
    const r = mkRouter();
    const turnStart = 1000;
    r.setCurModel(EXPENSIVE_GROUP_MEMBER);
    // setCurModel has no timestamp injection; emulate by choosing turnStart
    // in the past — getCurModel(turnStart) must return the ref.
    expect(r.getCurModel(turnStart)).to.equal(EXPENSIVE_GROUP_MEMBER);
  });

  it('returns empty when the stream ref is from a PREVIOUS turn (stale)', async () => {
    const r = mkRouter();
    r.setCurModel(EXPENSIVE_GROUP_MEMBER);
    // Wait until Date.now() advances past the internal set timestamp.
    await new Promise((res) => setTimeout(res, 5));
    const nextTurnStart = Date.now() + 1;
    expect(r.getCurModel(nextTurnStart)).to.equal('');
  });

  it('without a turnStart argument, returns the last stream ref (display use)', () => {
    const r = mkRouter();
    r.setCurModel(EXPENSIVE_GROUP_MEMBER);
    expect(r.getCurModel()).to.equal(EXPENSIVE_GROUP_MEMBER);
  });
});

// ── Turn-pinned driving ref (nested-delegation blind spot) ────────────────
//
// The expensive-model read block used the LIVE stream ref
// (getCurModel(turnStart)). Two mid-turn paths defeated it:
//   (1) a nested bulk_reader delegation stream calls setCurModel(cheapRef)
//       mid-turn, after which getCurModel() reports the CHEAP ref and the
//       expensive model's own subsequent full-file reads pass the block;
//   (2) a tool calling load() replaces the Router, resetting curModelAt to 0
//       so getCurModel(turnStart) returns ''.
// The fix pins the turn's driving ref in a field nested setCurModel calls
// cannot overwrite; the tool_call hook prefers it.

describe('Router turn driver pin', () => {
  const mkRouter = () => new Router(makeCfg(), {} as never, new Map() as never);

  it('nested delegation setCurModel mid-turn does NOT overwrite the turn pin', () => {
    const r = mkRouter();
    r.noteTurnStart(1000);
    r.setCurModel(EXPENSIVE_GROUP_MEMBER); // the orchestrating model opens the turn
    r.setCurModel(CHEAP_LOCAL); // nested bulk_reader delegation stream, mid-turn

    // The live ref now reports the cheap model …
    expect(r.getCurModel(1000)).to.equal(CHEAP_LOCAL);
    // … but the turn is still PINNED to the model driving it.
    expect(r.getTurnDriverRef(1000)).to.equal(EXPENSIVE_GROUP_MEMBER);
  });

  it('a cheap model driving the turn is not misreported as expensive', () => {
    const r = mkRouter();
    r.noteTurnStart(1000);
    r.setCurModel(CHEAP_LOCAL);
    r.setCurModel(EXPENSIVE_GROUP_MEMBER); // e.g. a fallback candidate tried later
    expect(r.getTurnDriverRef(1000)).to.equal(CHEAP_LOCAL);
  });

  it('end-to-end: a full-file read is still blocked for the expensive driver after a nested cheap stream', () => {
    const r = mkRouter();
    r.noteTurnStart(1000);
    r.setCurModel(EXPENSIVE_GROUP_MEMBER);
    r.setCurModel(CHEAP_LOCAL); // nested delegation blanks the live ref

    const streamRef = resolveReadBlockStreamRef(r, 1000, '');
    expect(streamRef).to.equal(EXPENSIVE_GROUP_MEMBER);
    // The read that WOULD have slipped through with the live ref alone:
    // smallFile is 20 lines, far below block_lines 350, so only the
    // expensive-model escalation can block it.
    const out = checkReadBlock({ toolName: 'read', input: { path: smallFile } }, makeCfg(), streamRef);
    expect(out).toBeDefined();
    expect(out?.expensive).to.equal(true);
  });

  it('load()-reset: a Router replacement mid-turn keeps the pin via adoptTurnDriverRef', () => {
    const turnStart = Date.now();
    const before = mkRouter();
    before.noteTurnStart(turnStart);
    before.setCurModel(EXPENSIVE_GROUP_MEMBER);
    before.setCurModel(CHEAP_LOCAL);

    // load() builds a fresh Router — curModelAt starts at 0, so the live
    // ref alone would return '' and the block would fall back to the
    // session ref. The pin is carried over explicitly.
    const after = mkRouter();
    after.noteTurnStart(turnStart);
    after.adoptTurnDriverRef(before.getTurnDriverRef(turnStart));

    expect(after.getCurModel(turnStart)).to.equal('');
    expect(after.getTurnDriverRef(turnStart)).to.equal(EXPENSIVE_GROUP_MEMBER);
    const out = checkReadBlock(
      { toolName: 'read', input: { path: smallFile } },
      makeCfg(),
      resolveReadBlockStreamRef(after, turnStart, '')
    );
    expect(out?.expensive).to.equal(true);
  });

  it('re-pins on the next turn: the new turn’s first stream ref becomes the driver', async () => {
    const r = mkRouter();
    r.noteTurnStart(1000);
    r.setCurModel(EXPENSIVE_GROUP_MEMBER);
    expect(r.getTurnDriverRef(1000)).to.equal(EXPENSIVE_GROUP_MEMBER);

    // Wait until Date.now() advances past the first pin's timestamp, so the
    // new turnStart is a REAL boundary (not a speculative future one).
    await new Promise((res) => setTimeout(res, 5));
    const nextTurn = Date.now();
    r.noteTurnStart(nextTurn);
    r.setCurModel(CHEAP_LOCAL);
    // Fresh turn → the pin is the cheap ref, and it is not stale.
    expect(r.getTurnDriverRef(nextTurn)).to.equal(CHEAP_LOCAL);
  });

  it('returns empty when the pin predates the turn (nothing streamed yet — fail-open)', () => {
    const r = mkRouter();
    r.setCurModel(EXPENSIVE_GROUP_MEMBER); // previous turn, pinned
    const nextTurn = Date.now() + 1;
    r.noteTurnStart(nextTurn);
    // No setCurModel in the new turn yet → the old pin must not match.
    expect(r.getTurnDriverRef(nextTurn)).to.equal('');
    // …and the caller then falls back to the live/session ref.
    const out = checkReadBlock({ toolName: 'read', input: { path: smallFile } }, makeCfg(), '');
    expect(out).to.equal(undefined);
  });

  it('adoptTurnDriverRef("") is a no-op (nothing to carry)', () => {
    const r = mkRouter();
    r.adoptTurnDriverRef('');
    expect(r.getTurnDriverRef()).to.equal('');
  });
});

// ── resolveReadBlockStreamRef: the tool_call hook's ref composition ───────

describe('resolveReadBlockStreamRef', () => {
  const mkRouter = () => new Router(makeCfg(), {} as never, new Map() as never);

  it('prefers the pinned driving ref over the live ref (nested delegation blind spot)', () => {
    const r = mkRouter();
    r.noteTurnStart(1000);
    r.setCurModel(EXPENSIVE_GROUP_MEMBER);
    r.setCurModel(CHEAP_LOCAL); // nested cheap stream overwrites the live ref
    expect(resolveReadBlockStreamRef(r, 1000, '')).to.equal(EXPENSIVE_GROUP_MEMBER);
  });

  it('falls back to the live ref when nothing is pinned this turn', () => {
    const r = mkRouter();
    r.noteTurnStart(1000);
    // No setCurModel at all in this turn → live ref empty too.
    expect(resolveReadBlockStreamRef(r, 1000, 'session/model')).to.equal('session/model');
  });

  it('falls back to the session ref for a fixed session that never routed', () => {
    const r = mkRouter();
    expect(resolveReadBlockStreamRef(r, 0, 'pi-claude/claude-sonnet-5')).to.equal(
      'pi-claude/claude-sonnet-5'
    );
  });

  it("returns '' when nothing is known — the block then applies size-only (fail-open)", () => {
    const r = mkRouter();
    expect(resolveReadBlockStreamRef(r, 1000, '')).to.equal('');
  });
});
