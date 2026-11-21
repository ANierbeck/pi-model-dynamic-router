# `/router fresh` in a busy session

**Status:** in progress — 2026-11-21. Owner decision on open decision 1: wait for the
running turn in up to three waits, then interrupt it.

**Verified against:** `origin/main` @ `03274c1`; Pi pi-coding-agent 1.6.0
(`dist/core/agent-session.js`). The router lines were read on
`feat/virtual-selection` @ `6b84d67`, where `src/fresh-session.ts`,
`src/commands.ts` and `src/context-compaction.ts` are unchanged from main.

## Problem

In a long session `/router fresh` cannot be used, and the hint that points to
it repeats.

- **The command aborts the turn it was typed into.** `handleFreshCommand`
  refuses anything but the TUI (`src/commands.ts:1425`), asks for confirmation,
  and calls `ctx.compact()` (`src/commands.ts:1468`). Pi's `compact()` first
  aborts the running turn (`agent-session.js:2335–2336`). Extension commands
  run immediately even while the agent streams (`agent-session.js:1714`), so
  the command kills the work it was meant to hand over.
- **A large context gets a skeleton handoff.** The handoff waits
  `FRESH_WAIT_MS` = 30 s for the first completed compaction
  (`src/fresh-session.ts:81`). After that it starts the new session with no
  summary (fail-open). A long context can take longer than that, so the
  session that needs the handoff most gets the least of it.
- **The hint repeats.** `src/context-compaction.ts` (around line 290) emits
  `fresh session suggested — … — /router fresh` whenever `decideFreshStart`
  says so. The only limit is `HINT_COOLDOWN_MS`, shared with the 5b hint. The
  owner's user config enables it (`context_budget.fresh_session.enabled: true`).
  The router log holds 8 such lines for 2026-11-21 alone.
- **Not verified:** what the owner saw when the command was tried. The router
  log has no entry for the command, so the failure mode above is derived from
  the code, not observed.

## Solution

1. **Never abort the turn.** The command confirms, then waits for the current
   turn to end (`waitForIdle()`, available on the command context,
   `agent-session.js:1734`), then runs the handoff. The notice says it is
   queued behind the turn.
2. **Say when the summary is missing.** When the 30 s wait ends with a
   skeleton, the notice and the new session's handoff message say so.
   The 30 s fail-open stays.
3. **Hint once per reason.** The fresh hint fires once per session per reason
   (`cold`, `idle`, `stuck`). It fires again only when the reason changes. The
   hint says the command runs after the current turn.
4. **No change to `/router status`.** It already shows the switch state.

## Steps (red first, AGENTS §4)

- [ ] Test: `/router fresh` while streaming does not call `compact` before the
  turn ends. Red against the current code, which compacts at once. Then
  implement the wait.
- [ ] Test: a handoff that ended in the skeleton says so in the notice. Red
  first, then implement.
- [ ] Test: the same reason does not re-fire the hint after the cooldown. Red
  first (the current code re-fires), then implement.
- [ ] CHANGELOG entry; no config key change, so the generated reference is
  unchanged.
- [ ] Gates: `npx tsc --noEmit`, `npm run lint`, `npx vitest run`,
  `npm run test:coverage` with thresholds unchanged.

## Open decisions

1. **During a turn: wait or refuse?** Recommended: wait (the user's intent is
   kept, no work is lost). Refusing is the alternative: a message, no queue.
2. **Summary wait length.** Recommended: keep 30 s fail-open and report the
   skeleton. A longer wait only after the compaction times are measured.
3. **Hint frequency.** Recommended: once per reason per session. The
   alternative is the current cooldown-only rule.
