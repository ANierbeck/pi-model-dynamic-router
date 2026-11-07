# Tool Follow-Up Keeps the Run's Group Implementation Plan

**Status:** proposed (2026-11-07) — second fix of the "no migration" decision
(`2026-11-04-virtual-models-routing.md`); item I3 in `TODO.md`.

**Problem:** A tool follow-up always falls back to the `simple` group, whatever
group the run started in. `src/stream-orchestrator.ts:396-414`: when the last
message is a `toolResult`, the candidate list is
`[lastDynamicModel, ...simple candidates]` and the group is the literal
`'simple'`. A planning, design or code_complex run whose driver hits one 429 or
one stall continues on cheap or free models for the rest of the agent run — and
stays there after the driver's cooldown has expired, because nothing remembers
which group the run belonged to. The user sees a strong model start a task and a
weak one finish it, with the tool results of the strong model in context.

**Solution:** Remember the run's driver and group when the run is classified, and
order the follow-up candidates from that memory.

1. **Red-first.** New `test/tool-follow-up-group.test.ts`: a `planning` run
   (driver fails once, cooldown set) whose next message is a `toolResult` must not
   be answered from `simple`. Assert the candidate order and the group passed to
   `driveStream`. The test must fail on today's `'simple'` literal.
2. **Remember.** At classification, store the run's driver ref and group (the
   session-keyed store of `2026-11-07-session-keyed-turn-state.md` is the natural
   home; if that plan is not done first, a field on the orchestrator context).
3. **Order.** Follow-up candidates = driver (once its cooldown has expired) →
   current ref → the run group's candidates → that group's `fallback_groups`.
4. **Free-tier guard.** With tools in the context, skip `:free` models and
   meta-routers unless the run group is `simple` (a free model cannot be trusted
   to continue a tool loop; this is the same reasoning as the agent-capability
   tier, ADR-0025 forbids naming models — derive the set, do not list it).
5. **No regression for real `simple` runs.** A `simple` run keeps today's order.

**Open decisions (owner):**

1. **What is "the run"?** One agent run (until the last assistant message without
   tool calls) or the whole session? Proposal: the run, reset on a new user turn
   that is not a tool follow-up.
2. **Interaction with HINT.** A user-pinned model must still win; the run memory
   only orders the candidates the pin does not cover.

**Verified against:** `main` @ `daa9623` (2026-11-07). Checked: the
`isToolFollowUp` branch and its `'simple'` literal, the `TODO.md` I3 entry
(first registered 2026-10-25), and the existing follow-up tests by grep.
**Not checked:** how often the degradation actually happens in the logs — the
decision-log replay that would quantify it is not built.
