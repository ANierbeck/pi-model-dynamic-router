# `--continue` restores the router group, not the model that answered last

**Status:** in progress — approved by the owner 2026-11-21 (option "the router
restores the group").

**Verified against:** `main` @ `4152053`; pi-coding-agent 1.6.0
`dist/core/sdk.js` L84–104 (model restore on an existing session) and L297–302
(the initial `model_change` of a new session), `dist/core/virtual-models.js`
L29–42 (`getBranchSelection`), `dist/core/agent-session.js` L330–348
(`_recordModelSelection`) and L2126 (`setModel` appends a `model_change`);
`src/group-registration.ts` (group model ids), `src/routing.ts`
(`isVirtualGroupRef`). Not verified live: that `ctx.model` in `session_start`
is the restored model (step 4 checks it).

**Related:** `docs/plans/2026-11-04-virtual-models-routing.md` (Pi restores a
virtual model's selection on its own — a migration would make this plan
obsolete; the re-evaluation is registered in `TODO.md`).

## Problem

A user who works with a router group (`dynamic`, `planning`, …) and restarts
with `pi --continue` (or `/resume`, `/fork`) lands on the concrete model the
router chose last, not on the group. From then on no request is routed.

Cause, in Pi: a session restores its model with `getBranchSelection`. A
`model_change` only outlives the assistant messages after it when the model it
names is a Pi *virtual* model (`api: "pi-virtual"`); otherwise the latest
assistant message wins. Router group models are ordinary providers
(`api: "router-group-<name>"`), and every assistant message names the physical
model that answered (the router forwards the real provider's message). So the
latest response always wins and the group is lost.

During a session nothing goes wrong: Pi keeps the group model as the session
model and does not record the responses as selections.

## Solution

At `session_start`, after the group models are registered, the router puts the
group back when Pi fell back to the last responder:

1. On the current branch, the latest `model_change` names a router group model
   (`isVirtualGroupRef`).
2. The session's current model is not a group model and equals the model of
   the latest assistant message that names no Pi virtual model, whatever its
   stop reason — exactly what `getBranchSelection` falls back to (the router
   forwards a physical model's aborted or failed message unchanged).
3. The session has a UI (`ctx.hasUI`: TUI or RPC). pi-subagents forks the
   parent's branch into child sessions and starts them headless with reason
   `startup`; a child given exactly the model that answered the parent last
   would otherwise look like Pi's fallback and lose its explicit model.
4. Then the router calls `pi.setModel` with the registered group model (Pi
   records a `model_change` for it) and puts the branch's thinking level back
   (Pi's `setModel` takes it from the settings, Pi's resume from the branch).
   The handler returns the switch, so Pi awaits it before the first prompt;
   the switch's own `model_select` is not logged as a user pick.

A deliberate `/model` switch to a concrete model writes its own `model_change`
(condition 1 fails) and is respected. `reload` and new sessions are no-ops
(the current model is still the group, or there is no history). The decision
is a pure function (`src/session-restore.ts`), the handler only wires it.

Second `pi.setModel()` caller: `src/tools.ts` documents
`set_model_from_group` as the only one; the comment is updated.

## Steps

1. Red-first: unit pins for the decision, a wiring pin through `session_start`.
2. Implement `src/session-restore.ts` and the wiring.
3. Docs: README (session restore), CHANGELOG, architecture module map.
4. Live check (owner): `pi --continue` on a router session shows the group in
   the footer and routes the next request; also after aborting the last reply
   (Esc), and with the session's thinking level unchanged.

## Open decisions

None open. Known limits (documented):

- Print mode (`pi -p --continue`) is not restored: it has no UI and cannot be
  told apart from a headless subagent child.
- `pi --continue --model <x>` where `<x>` is exactly the model that answered
  last cannot be told apart from Pi's fallback, so the router restores the
  group; pass a different model or switch with `/model` after the start.
