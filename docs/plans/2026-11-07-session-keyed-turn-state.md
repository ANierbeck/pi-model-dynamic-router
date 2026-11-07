# Session-Keyed Turn State Implementation Plan

**Status:** proposed (2026-11-07) — owner decision of 2026-11-07: no virtual-model
migration, fix the turn-state problems in the current design
(`2026-11-04-virtual-models-routing.md`). This is the first of those fixes.

**Problem:** The router's turn state lives in closure variables of the extension
factory (`index.ts`): `turnStart` (196), `curModel` (200), `activeGroup` (202),
`lastDynamicModel` (203), `lastClassifiedCategory` (208),
`previousMessageCount`/`previousTokenCount` (211-212), `escalation` (216),
`skipReasons` (218) — plus the `Router` fields `curModel`/`curModelAt`/
`turnDriverRef`/`turnDriverAt` (`src/routing.ts:493-505`). That state is **per
process, not per session**. Every session in the same pi process shares it, so a
subagent session (pi-subagents calls `createAgentSession` in-process) inherits the
parent's `curModel` and `lastDynamicModel` and overwrites them. Clearing on
`session_shutdown` was considered and rejected, because a child's shutdown would
then wipe the parent's turn model (TODO, "I2 remainder / M1"). The visible
consequence: after a subagent run, the parent's next turn can continue on the
child's model, and the category memory of `lastClassifiedCategory` can carry a
subagent's task into the parent's next short prompt.

**Solution:** Key the turn state by session id instead of by process.

1. **Red-first.** New `test/session-keyed-turn-state.test.ts`: one extension
   instance, two session ids. Session A sets `lastDynamicModel`/`curModel`/
   `lastClassifiedCategory`; session B must see its own (empty) values, and A's
   values must survive B's writes and B's shutdown. The test must fail against
   today's closure variables before the store exists.
2. **Store.** New `src/turn-state.ts` with `TurnStateStore`: `get(sessionId)`,
   `reset(sessionId)`, and a bounded map (LRU, small cap — a long-lived process
   sees many sessions; unbounded growth would be a leak).
3. **Wire.** Resolve the session id per event and per stream call —
   `ctx.sessionManager.getSessionId()` in handlers, `options.sessionId` in
   `streamSimple` (Pi sets it; measured, research note §6) — and replace the
   closure reads/writes with store reads/writes. `Router`'s turn fields move into
   the same store or take the state as a parameter.
4. **Shutdown.** `session_shutdown` resets **only that session's** entry — the
   reason the clear was not done before disappears with the key.
5. **Sub-call scope stays.** The async-local sub-call scope (PR #118 era) keeps
   guarding turn-model writes; the store must not reintroduce the "a delegated
   sub-call hijacks the turn model" bug. A regression test asserts both
   mechanisms together.

**Open decisions (owner):**

1. **Scope of the move.** Only the three variables behind I2/I3/I5 (`curModel`,
   `lastDynamicModel`, `lastClassifiedCategory` — 57 references, 8 files) or all
   of the per-turn state (~184 references, 15 files)? Proposal: the three plus
   `activeGroup`/`turnStart`; `escalation` and `skipReasons` are rebuilt per turn
   and can follow later if the seam is clean.
2. **Eviction.** Cap (e.g. 64 sessions) and policy (LRU) — proposals, not fixed.
3. **Persistence across restart** is explicitly **out of scope**: it was the one
   real advantage of the virtual-model state (research note §6), and it is not a
   reported bug.

**Verified against:** `main` @ `daa9623` (2026-11-07). Checked in the code:
`index.ts:196-218`, `src/routing.ts:487-577`, the `sessionId` plumbing in
`@earendil-works/pi-coding-agent` (`dist/core/sdk.js:276` passes
`sessionManager.getSessionId()`, `pi-agent-core/dist/agent.js:311` forwards it),
and the reference counts by grep. **Not checked:** whether the extension factory
is re-invoked for an in-process subagent session (if it is, the bug is smaller
than assumed — the test in step 1 answers it).
