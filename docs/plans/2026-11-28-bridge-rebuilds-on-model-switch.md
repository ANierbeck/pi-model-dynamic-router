# Model switches force full history rebuilds in `pi-mistral-bridge`

**Status:** proposed — under discussion (2026-11-28). Not approved; no option
is chosen. Taken over from a hand-over draft of the bridge's abort diagnosis
(2026-11-27), which also proposed a sticky model per session.

**Verified against:** `main` @ `ff3d801`; the bridge repository @ `84a47ec`
(release 0.1.3: ADR-0003, ADR-0007, ADR-0010, `src/provider.ts:243,977-978`,
its 2026-11-24 ACP surface research); the owner's Pi session files
2026-11-18 to 2026-11-28 (numbers in
`docs/research/2026-11-28-bridge-model-switches.md`). What was NOT checked:
what a rebuild costs in tokens and time per switch (not measured), whether
`vibe-acp` honours `session/load` (advertised, never exercised), and whether
the abort diagnosis's "tool-call imitation" deaths still happen with 0.1.3's
non-imitable rebuild history.

The hand-over draft's second problem, "bridge failures are invisible to the
router", is already handled: since bridge 0.1.3 a dead turn ends as an `error`
event, and the router fails over on it (see the research note). It needs no
plan of its own.

## Problem

`pi-mistral-bridge` keeps one `vibe-acp` process and ACP session per model
(bridge ADR-0007). It sends only the new message when the history matches its
recorded digest. The digest includes the model, so every time the router
hands a bridge session to a different model, the bridge rebuilds: it re-sends
the whole transcript to the new model's process (bridge ADR-0003). A rebuild
is the riskiest turn type the abort diagnosis found: both investigated
sessions died in turns right after a compaction or rebuild, and one bridge
session compacted six times.

In ten days of the owner's sessions, a bridge model was entered after another
model 18 times. 6 of those switches came from the router's per-prompt
selection, 12 happened inside a turn (failover, fallback or tool follow-up).

Every switch also re-sends the context uncached on the new model, on any
provider, not only the bridge. In a bridge session it additionally costs a
rebuild.

## Solution — options, to be decided

**A. Sticky model per session (the draft's proposal).** Keep the selected
model for the rest of the session; re-select only when it cannot serve
(context window, hard error) or the user switches.
- Owner objection 2026-11-28: on an expensive model, sticky keeps every
  following turn there, including the cheap ones, and burns tokens. A session
  that started with one hard planning prompt on the top model would never
  come down.
- It addresses at most the 6 turn-start switches, not the 12 inside a turn.
- Not recommended as the default.

**B. Switch-cost-aware selection (router).** A switch has a price: the
context re-sent uncached on the new model, plus a rebuild on a bridge
provider. Switch only when the expected saving over the next steps pays for
it; otherwise keep the current model. This is the same reasoning as the
cache-aware compaction (`docs/plans/2026-10-05-task-type-balancing.md`, 5b:
the cold-cache moment is the cheap moment).
- It answers the owner's objection: an expensive model is left as soon as
  coming down pays, typically at once for a small context, later for a large
  one.
- It needs a per-provider "switch penalty" signal. Under AGENTS §9 that is a
  provider adapter property (ADR-0025 §2 A), not a model name.

**C. Failover avoids cold bridge sessions (router).** Inside a turn, when
several candidates fit, prefer one that needs no rebuild: the model that
already served this session, or a provider without a switch penalty. This
targets the 12 mid-turn entries. It is ordering only; it never removes a
candidate, so a failover still finds a model.

**D. Session continuity in the bridge (counter-proposal to the bridge).** Fix
the cost where it arises: when a session comes back to a model whose process
still holds an older ACP session of it, send only the turns that other models
served in between (a catch-up delta) instead of the whole transcript. After a
process restart, try `session/load`. In-session model switching stays
excluded until Vibe offers a non-persisting `set_config_option` over ACP
(bridge ADR-0007). The text for the bridge is in the open decisions below.
This needs no router change. It shrinks every rebuild, whatever caused the
switch.

**Recommendation (for discussion):** D first, because it removes the cost for
every switch cause without a cost trade-off in the router. Then measure what a
rebuild still costs. B and C only if the measurement shows switches stay
expensive. A only as an opt-in per group, never as the default.

## Tests

None yet. The option the owner chooses gets red-first tests (AGENTS §4)
before any code. For B and C, a driveStream test in the style of
`test/rate-limit-wait.test.ts`; for D, the bridge's own suite.

## Open decisions

1. Which options to pursue: D only, D + B/C, or A as an opt-in.
2. Whether the router may know about a "switch penalty" per provider at all,
   or whether that stays the bridge's business (D only).
3. Before B or C: measure the price of a rebuild (tokens, latency, failure
   rate after it) from the bridge's own logs.
4. The counter-proposal to the bridge (D): passed on by the owner. The router
   repository does not write to the bridge.
