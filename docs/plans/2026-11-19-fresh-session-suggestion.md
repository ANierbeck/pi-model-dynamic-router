# Fresh-Session Suggestion Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill (or subagent-driven development) to implement task-by-task.

**Goal:** Implement Task-Type Balancing step 5c — suggest a fresh session with a handoff summary when the context cache stops paying off, and provide `/router fresh` to perform the handover.

**Architecture:** A pure trigger module decides *when* a fresh start beats continuing (cold cache × large context × per-session compaction count). The suggestion is narration only, surfaced through the existing Phase-5b hint channel. The actual handover is a new user-invoked `/router fresh` subcommand that compacts the current session (produces the summary), then starts a new session linked via `parentSession`, seeded with the summary as its first prompt.

**Tech Stack:** TypeScript (ESM, `.ts` imports, NodeNext), vitest, the installed pi host's Extension API (`@earendil-works/pi-coding-agent` 1.5.2).

---

**Status:** Done 2026-11-19 — PR #193. Deviation from Task 2, deliberate:
`/router status` shows the SWITCH state (`fresh-session suggestion: on|off`),
not the live suggestion line — the suggestion is only computable at a turn
boundary (its inputs are the last step's cache state), so status never
pretends to know whether it would fire right now (PR #193 review).

**Problem:** After a long session the context cache grows (measured: cacheRead is 72 % of all tokens and the cost driver), summarisation quality of "the same huge irrelevant context" degrades, and compacting in place (Phase 5b) only keeps the already-paid context alive. At some point a **fresh session with a handoff summary** is the better move. Step 5c of `docs/plans/2026-10-05-task-type-balancing.md` recorded this as "deferred to a 2.0 version"; the owner has now pulled it back into the 2.0 scope.

**Solution:** (1) A pure trigger function over the already-recorded Phase-5a/5b signals decides when a fresh start is cheaper than continuing; it may only *narrate a suggestion*. (2) `/router fresh` executes the suggestion: it prompts for confirmation, runs compaction to obtain the summary, then switches to a new session wired to the old one via `parentSession`, and seeds the summary as the first prompt. Never forced: the suggestion is a line in the status surface; the switch is always the user's own command.

**Open decisions:** none blocking implementation. Default configuration values are pinned below; the owner changed them if desired during plan review.

**Verified against:** `main` @ `533b813` (2026-11-19). Pi host API surfaces verified in the installed host 1.5.2:
- `ExtensionCommandContext.newSession({ parentSession?, setup?, withSession? })` — command handlers only (user-invoked), `dist/core/extensions/types.d.ts:312`.
- The host itself records the `parentSession` link (`dist/core/agent-session-runtime.js:205` — `sessionManager.newSession({ parentSession: currentSessionFile })`); extensions do NOT pass it manually.
- `withSession(replacedCtx)` receives a `ReplacedSessionContext` exposing `sendMessage(..., { triggerTurn })` and `sendUserMessage(...)` — used to seed the handoff prompt.
- Captured extension ctx is **stale** after `newSession()` — post-switch work must happen inside `withSession` (loader warning, `dist/core/extensions/loader.js:151`).
- Compaction summary arrives via the `session_compact` event (`dist/core/extensions/types.d.ts:610/632`, carries `compactionEntry`).
- Existing Phase-5b surfaces this plan builds on: `src/context-compaction.ts` (`LastStepCacheState`, `isCacheCold`, `CACHE_MISS_SHARE_THRESHOLD`, `HINT_COOLDOWN_MS`, `CompactionRunState { lastHintAt }`), `decideCompaction`, `runContextCompaction` (turn_start hook only, fire-and-forget, fail-open), `resolveContextBudget` (per-group merge), `ContextBudgetConfig { enabled, soft_tokens, hard_tokens, cache_ttl_s }`.

---

## Task 1: Trigger heuristic (pure function) + config type

**Files:**
- Create: `src/fresh-session.ts`
- Create: `test/fresh-session.test.ts`
- Modify: `src/types.ts` (add `FreshSessionConfig`, add `fresh_session?: FreshSessionConfig` to `ContextBudgetConfig`)

**Step 1: Red — write the failing heuristic tests**

`test/fresh-session.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { FRESH_DEFAULTS, decideFreshStart, freshStatusLine } from '../src/fresh-session.ts';
import type { ContextBudgetConfig } from '../src/types.ts';

const budget = (over: Partial<ContextBudgetConfig> = {}): ContextBudgetConfig | undefined =>
  ({
    enabled: true,
    soft_tokens: 100_000,
    hard_tokens: 200_000,
    cache_ttl_s: 300,
    ...over,
  }) as ContextBudgetConfig;

const input = (over: Record<string, unknown> = {}) => ({
  budget: budget(),
  freshEnabled: true, // fresh_session.enabled: true
  cold: true,
  contextTokens: 150_000,
  contextWindow: 200_000,
  secondsSinceLastSuccess: 4 * 60,
  stepsSinceSessionStart: 40,
  compactionsThisSession: 2, // repeated compactions: 5b already tried twice
  now: 1_800_000_000_000,
  ...over,
});

describe('fresh-session suggestion', () => {
  it('suggests when the cache is cold, the context is large, and compaction is not sticking', () => {
    const d = decideFreshStart(input());
    expect(d).toMatchObject({ suggest: true, reason: expect.stringMatching(/compaction is not sticking/) });
  });

  it('suggests when the cache went cold from idling, context share is high', () => {
    const d = decideFreshStart(input({ cold: false, secondsSinceLastSuccess: 20 * 60 }));
    expect(d.suggest).toBe(true);
  });

  it('never suggests while the cache serves hits on a small context', () => {
    const d = decideFreshStart(
      input({ cold: false, secondsSinceLastSuccess: 10, contextTokens: 20_000, compactionsThisSession: 0 })
    );
    expect(d).toEqual({ suggest: false });
  });

  it('respects the context share gate before suggesting', () => {
    const d = decideFreshStart(
      input({ contextTokens: 150_000, contextWindow: 1_000_000 }) // 15% share
    );
    expect(d.suggest).toBe(false);
  });

  it('respects after_turns (default) before suggesting', () => {
    const d = decideFreshStart(input({ stepsSinceSessionStart: 3 }));
    expect(d.suggest).toBe(false);
  });

  it('is off when the feature is disabled — the shipped default', () => {
    expect(decideFreshStart(input({ freshEnabled: false })).suggest).toBe(false);
    expect(decideFreshStart(input({ budget: undefined })).suggest).toBe(false);
  });

  it('exposes the shipped defaults', () => {
    expect(FRESH_DEFAULTS.min_ctx_share).toBe(0.6);
    expect(FRESH_DEFAULTS.after_turns).toBe(10);
  });
});
```

**Step 2: Run — verify red**

`npx vitest run test/fresh-session.test.ts` — fails: cannot find module `../src/fresh-session.ts`.

**Step 3: Implement**

`src/fresh-session.ts`:

```typescript
/**
 * Task-type balancing step 5c (`docs/plans/2026-11-19-fresh-session-suggestion.md`):
 * when the context cache stops paying off — cold cache, large context, compaction
 * not sticking — a FRESH session with a handoff summary beats continuing. This is
 * advisory only: the suggestion is narration; the switch is the user's
 * `/router fresh` command (Pi only allows newSession() from user-invoked
 * commands). Signal inputs come from the Phase-5a measurement (usage_log
 * cacheRead share) and Phase-5b state (per-session compaction count);
 * no per-user values are hardcoded — everything is a config key or a code
 * default recorded here and in config-keys.ts.
 */
import type { ContextBudgetConfig } from './types.ts';

export const FRESH_DEFAULTS = {
  /** Only suggest at or above this context share of the model's window. */
  min_ctx_share: 0.6,
  /** Only suggest after at least this many steps in the session. */
  after_turns: 10,
  /** Cache considered cold when the idle gap exceeds this (seconds). */
  cold_idle_s: 15 * 60,
} as const;

export interface FreshSessionInputs {
  budget: ContextBudgetConfig | undefined;
  freshEnabled: boolean;
  /** Cache cold in the CURRENT-step sense (Phase 5a/5b): miss share or TTL. */
  cold: boolean;
  contextTokens: number | null;
  contextWindow: number | null;
  secondsSinceLastSuccess: number | null;
  stepsSinceSessionStart: number;
  /** How often 5b compaction already ran in THIS session. */
  compactionsThisSession: number;
  now: number;
}

export type FreshSessionDecision = { suggest: true; reason: string } | { suggest: false };

export function decideFreshStart(i: FreshSessionInputs): FreshSessionDecision {
  if (!i.freshEnabled || !i.budget) return { suggest: false };
  if (i.contextTokens === null || i.contextTokens <= 0) return { suggest: false };
  if (i.stepsSinceSessionStart < FRESH_DEFAULTS.after_turns) return { suggest: false };
  if (i.contextWindow === null || i.contextWindow <= 0) return { suggest: false };
  if (i.contextTokens / i.contextWindow < FRESH_DEFAULTS.min_ctx_share) return { suggest: false };
  const idledOut =
    i.secondsSinceLastSuccess !== null && i.secondsSinceLastSuccess > FRESH_DEFAULTS.cold_idle_s;
  const stuck =
    i.compactionsThisSession >= 2 && i.contextTokens >= (i.budget.soft_tokens ?? 0);
  if (!(i.cold || idledOut || stuck)) return { suggest: false };
  const reason = idledOut
    ? 'cache went cold from idling; a fresh session restarts cheap'
    : stuck
      ? 'compaction is not sticking: context grew back; a fresh session wins'
      : 'cache cold and context large: continuing pays full price either way';
  return { suggest: true, reason };
}
```

Add to `src/types.ts` inside `ContextBudgetConfig`:

```typescript
  /**
   * Task-type balancing step 5c: suggest (never force) a fresh session when
   * the context cache stops paying off. Off by default. See
   * src/fresh-session.ts and docs/plans/2026-11-19-fresh-session-suggestion.md.
   */
  fresh_session?: { enabled?: boolean };
```

**Step 4: Verify green**

`npx vitest run test/fresh-session.test.ts` — all pass.

**Step 5: Commit**

```bash
git add src/fresh-session.ts test/fresh-session.test.ts src/types.ts
git commit -m "feat: fresh-session suggestion heuristic (task-type balancing 5c, red-first)"
```

---

## Task 2: Surface the suggestion (5b hint channel + /router status)

**Files:**
- Modify: `src/context-compaction.ts` (count per-session compactions, hand inputs to `decideFreshStart`)
- Modify: `src/commands.ts` (status line)
- Test: `test/fresh-session.test.ts` (extend)

**Step 1: Red — pin the status line + wiring contract**

Append to `test/fresh-session.test.ts`:

```typescript
describe('fresh-session wiring contract', () => {
  it('counts compactions from the run state and derives the hint', async () => {
    const { freshStatusLine } = await import('../src/fresh-session.ts');
    expect(
      freshStatusLine({
        suggest: true,
        reason: 'cache cold and context large: continuing pays full price either way',
      })
    ).toMatch(/fresh session .* \/router fresh/s);
    expect(
      freshStatusLine({
        suggest: true,
        reason: 'cache went cold from idling; a fresh session restarts cheap',
      })
    ).toMatch(/cache went cold from idling/s);
  });
});
```

**Step 2: Run — verify red** (`freshStatusLine` not exported yet).

**Step 3: Implement**

Export in `src/fresh-session.ts`:

```typescript
/** One narration line; used by /router status and the compaction hint path. */
export function freshStatusLine(d: FreshSessionDecision): string {
  return d.suggest
    ? `fresh session suggested — ${d.reason} — /router fresh`
    : '';
}
```

Wire-in (Task 2's second half):
- In `src/context-compaction.ts`, extend `CompactionRunState` with `compactionsRun: number`; increment it where 5b compaction actually runs; after the existing `decideCompaction` result, call `decideFreshStart(...)` with the assembled inputs and, when it suggests and the hint cooldown permits (reuse `HINT_COOLDOWN_MS`), append `freshStatusLine(...)` to the hint `ui.notify`.
- In `src/commands.ts` `/router status` output, append the same line when the inputs suggest.
- The per-session step counter comes from the turn-state store (`src/turn-state.ts`) — increment at `turn_end` (it is session-keyed; reuse whatever 5a uses for `stepsSinceSessionStart`; if absent, derive from `usageLog.length` filtered to this session's id).

**Step 4: Verify** — `npx vitest run test/fresh-session.test.ts test/context-compaction.test.ts test/router-command-help.test.ts` green.

**Step 5: Commit**

```bash
git add src/context-compaction.ts src/commands.ts test/fresh-session.test.ts
git commit -m "feat: surface the fresh-session suggestion via the 5b hint channel"
```

---

## Task 3: The `/router fresh` command (handover execution)

**Files:**
- Modify: `src/commands.ts` (`/router fresh` subcommand + `ROUTER_SUBCOMMANDS` entry)
- Create: `src/fresh-session.ts` additions (`FRESH_HANDLE_OFF_PROMPT`, handoff message builder)
- Test: `test/router-fresh-command.test.ts` (new)
- Test helper: reuse `test/helpers/extension-harness.ts`

**Step 0: API re-verify (cheap, deterministic)**

```bash
grep -n "newSession" ~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts | head
grep -n "sendUserMessage\|sendMessage" ~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts | head
```
Expected: `newSession({ parentSession?, setup?, withSession? })` on command ctx (line ~312); `sendMessage`/`sendUserMessage` on `ReplacedSessionContext` (~349). If the installed host has evolved, adapt to its signature — the test stubs pin OUR usage, and CI runs against the real host.

**Step 1: Red — command behavior tests**

`test/router-fresh-command.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { freshHandoffMessage } from '../src/fresh-session.ts';
import { createCommands } from '../src/commands.ts';
import { makeExtensionContext } from './helpers/extension-harness.ts';

/** Drives the registered /router command with the `fresh <rest>` argument. */
async function runFresh(args: string, ctx: any, commandDeps: any): Promise<string> {
  const dispatch = ctx.__routerHandler as (
    args: string,
    ctx: unknown
  ) => Promise<string>;
  return dispatch(args, ctx);
}

describe('/router fresh', () => {
  it('declines when the confirm dialog is answered NO — nothing switches', async () => {
    const ctx = makeExtensionContext({
      ui: { confirm: vi.fn().mockResolvedValue(false), notify: vi.fn() },
      newSession: vi.fn(),
      compact: vi.fn(),
    });
    await runFresh('fresh', ctx, baseDeps());
    expect(ctx.newSession).not.toHaveBeenCalled();
  });

  it('accepting compacts, then starts the linked session via withSession', async () => {
    const ctx = makeExtensionContext({
      ui: { confirm: vi.fn().mockResolvedValue(true), notify: vi.fn() },
      newSession: vi.fn().mockResolvedValue({ cancelled: false }),
      compact: vi.fn(),
      mode: 'tui',
    });
    let handler: ((fresh: any) => Promise<void>) | undefined;
    ctx.newSession.mockImplementation(async (o: any) => {
      handler = o.withSession;
      return { cancelled: false };
    });
    const freshCtx = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    await runFresh('fresh finish the laya gate', ctx, baseDeps());
    await handler?.(freshCtx); // the withSession callback runs post-replacement
    expect(ctx.compact).toHaveBeenCalledOnce();
    expect(ctx.newSession).toHaveBeenCalledOnce();
    expect(freshCtx.sendMessage).toHaveBeenCalledWith(
      expect.stringMatching(/finish the laya gate/),
      expect.objectContaining({ triggerTurn: true })
    );
  });
});
```

(Adapt `makeExtensionContext` / the dispatch helper to the existing harness shape; `baseDeps()` is a minimal `CommandDeps` stub like those in `test/commands.ts`.)

**Step 2: Run red.**

**Step 3: Implement (exact code)**

In `src/fresh-session.ts`:

```typescript
export const FRESH_HANDLE_OFF_PROMPT =
  'Summarise this session for a handover: the task, decisions made, files ' +
  'touched, and the exact next step. Be terse.';

/** The first prompt the new session receives: the summary plus the carry-over. */
export function freshHandoffMessage(summary: string | null, nextStep: string | null): string {
  const head = summary
    ? `Handover from the previous session (start fresh from here):\n\n${summary}`
    : 'Handover from the previous session; the summary was unavailable — read ' +
      'the last milestone in the session history and continue from there.';
  return nextStep ? `${head}\n\nNext step (user): ${nextStep}` : head;
}
```

In `src/commands.ts`, inside the `/router` handler dispatch:

```typescript
if (arg === 'fresh' || arg?.startsWith('fresh ')) {
  if (ctx.mode !== 'tui') { ctx.ui.notify('/router fresh needs the interactive UI', 'warning'); return; }
  const nextStep = arg.slice('fresh'.length).trim() || null;
  const ok = await ctx.ui.confirm(
    'Fresh session — start a new session with a handoff summary of this one?' +
      (nextStep ? ` Next step: ${nextStep}` : '')
  );
  if (!ok) { ctx.ui.notify('Fresh session cancelled — this session continues.', 'info'); return; }
  let summary: string | null = null;
  ctx.compact({ customInstructions: FRESH_HANDLE_OFF_PROMPT }); // summary lands in the session_compact event:
  const done = new Promise<void>((res) => {
    const off = rt.pi.on('session_compact', (ev) => {
      summary = (ev.compactionEntry as { summary?: string }).summary ?? null; // pad shape: verify at impl
      off?.(); res(); // single-shot: detach
    });
    setTimeout(res, 30_000); // fail-open: a slow compaction still yields a skeleton handoff
  });
  await done;
  const { cancelled } = await cmdCtxNewSession(rt, ctx, (fresh) =>
    fresh.sendMessage(freshHandoffMessage(summary, nextStep), { triggerTurn: true })
  );
  if (cancelled) ctx.ui.notify('Fresh session was cancelled by the host — staying here.', 'warning');
  else ctx.ui.notify('Fresh session started — the handoff summary is its first prompt.', 'info');
  return;
}
```

- `cmdCtxNewSession` wraps `ctx.newSession({ withSession })` so the typed host surface (only command ctx has it; captured ctx is stale after the switch — loader rule) stays in ONE place and is stub-able in tests.
- `parentSession` is NOT passed: the host wires it (`agent-session-runtime.js:205`).
- Register in `ROUTER_SUBCOMMANDS`: `fresh — start a new session with a handoff summary (task-type balancing 5c)`.

**Step 4: Verify** — `npx vitest run test/router-fresh-command.test.ts test/router-command-help.test.ts` green; `npx tsc --noEmit` clean.

**Step 5: Commit**

```bash
git add src/commands.ts src/fresh-session.ts test/router-fresh-command.test.ts test/helpers/extension-harness.ts
git commit -m "feat: /router fresh — user-invoked session handover with summary (5c)"
```

---

## Task 4: Config keys + generated reference + docs

**Files:**
- Modify: `src/config-keys.ts` (entry for `context_budget.fresh_session.enabled`)
- Modify: `docs/config-reference.md` (regenerated — do not hand-edit)
- Modify: `README.md` (task-type balancing section), `CHANGELOG.md` (Changed/2.0.0 entry), `TODO.md` (uncheck/mark 5c as done), `docs/plans/README.md` (index row), `docs/plans/2026-10-05-task-type-balancing.md` (5c bullet: replace "deferred" with "implemented — see plan 2026-11-19")
- Test: `test/config-reference-docs.test.ts` (green by regeneration)

**Steps:** config-keys entry (`path: 'context_budget.fresh_session.enabled'`, `kind: 'boolean'`, `shipped: 'false (code default)'`, meaning: suggests — never forces — a fresh session; the `/router fresh` command works regardless of this switch); `node scripts/config-reference.ts --write`; doc bullets; **commit** `docs: fresh-session suggestion (5c) — config surface and docs`.

---

## Task 5: Full gates + PR

- `npx tsc --noEmit` clean, `npm run lint` 0 findings, `npx prettier --check .` clean, `npx vitest run` green (count + skipped update in AGENTS.md ratchet if changed), `npm run build` ok.
- Branch per §8, PR with body (root cause, evidence: the red-first runs, gates), merge only after all three review endpoints read; no release actions.

---

## Risks / known limits

- The `session_compact` event payload's summary field must be verified once against host 1.5.2 at implementation time (Task 3 Step 0 covers it). Fail-open: a 30-second timeout leaves a skeleton handoff — a stale summary never loses work.
- `compactionsThisSession` is per-process state (like `CompactionRunState`); a Pi restart resets the count. Accepted for 2.0; noted in the module doc.
- The suggestion fires only at turn boundaries (5b hook discipline; never mid-turn) and never forces anything — the command is the only switch.
