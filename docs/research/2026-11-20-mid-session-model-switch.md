# Mid-session model switch (downgrade) — mechanics and cost

**Status:** research note. Owner observation 2026-11-20: in a longer
back-and-forth the model never changes (acceptable), but a mid-session switch
might be interesting — with the caveat that it destroys the prompt cache, and
bulk reading must keep working either way. No decision taken yet; this note
collects the mechanics and the cost math. Direction if ever: **downgrade
only** (upgrades are covered by classification: a genuinely harder request in
a new turn switches already, and the user wants that switch even at cache
cost).

**Verified against:** repo `main` @ `e3d95fba` (incl. the cache-warming merge,
PR #199): `src/stream-orchestrator.ts` (run memory), `src/delegation.ts`
(delegation gates), `src/content-classifier.ts`
(`inheritPreviousCategory`), the Phase-5 measurement
(`docs/research/2026-10-05-*` cost numbers), the 5c mechanism
(`src/fresh-session.ts`).

## Current mechanics (why the model does not change)

- **Every new user turn is reclassified** (`stream-orchestrator.ts`, after
  `clearRun`). The model only *stays* for two reasons:
  1. **Short confirmations classify as `fallback`**, and `fallback` inherits
     the previous category (`inheritPreviousCategory`) — "ok", "weiter", "ja"
     keep the session's group and therefore its model.
  2. Same category → same candidate pool → same ranking → the same model
     wins. The model only "changes" when ranking inputs change (cooldown,
     breaker, pricing), which is rare mid-session.
- **Within a turn** the model never changes: tool follow-up steps stay in the
  run's group and on the run's model (`runGroup`/`runDriver`,
  `stream-orchestrator.ts` L220-230).

So a genuine topic change between turns already switches the model today —
and pays the cold cache once, which the owner accepted for upgrades. What
does **not** happen is a downgrade on drift: a session that started as
planning stays on the planning model even when it degrades into short Q&A,
because every short message inherits `planning`.

## Bulk reading is structurally independent

The oversized-tool-result check runs on the `tool_result` event
(`handleReadDelegation`, `src/delegation.ts`), as a sub-call through the
delegation group's provider — independent of which model the turn uses, of
run memory, pins and hints. Nothing in a mid-session switching design touches
that path; the only coupling ever found (sub-calls writing turn/warm state)
was closed in PR #199. Any switching design must preserve exactly that: the
delegation decision may depend on config and the content, never on which
model the session currently uses.

## Cost math

Switching models at context C destroys the cache once: the next request pays
C at the uncached input price. With the measured numbers (200k context,
GLM-class pricing: 1.4/M input vs 0.14/M cache-read) that is ≈ $0.28 once.
Every further step then saves the price delta between the two models per
step. So a switch pays off when many steps remain at the cheaper model and
the per-step delta is large; near the session's end it is a pure loss.

The key alignment: **a switch is free exactly when the cache is cold anyway**
(TTL expired, after a compaction, session just resumed). That is the same
condition the 5c fresh-session suggestion fires on. Any automatic switch
should therefore be gated on the cache being cold already, or on an explicit
amortization estimate (remaining-steps × price-delta > one full-price read);
otherwise it is a pure loss near the session's end.

## Mid-turn variant (while the turn is working)

Owner clarification 2026-11-20: the interesting moments are not user turns
but the steps WHILE a turn executes — every time new decisions/insights are
sent to the model backend mid-work. Verdict: switching the MAIN thread
mid-turn does not pay, and the healthy core of the idea already exists:

- **Failover already is mid-turn switching** — on failure. A model error or
  stream throw mid-turn walks the candidate list immediately. What does not
  exist is switching on cost/quality signals while everything works.
- **The bulk_reader sub-call already is the mid-turn model switch that
  makes sense**: oversized tool output is summarized by a cheap model as a
  sub-call while the main thread keeps its model, its plan and its cache.
  The owner's condition "bulk reading must keep being intercepted" IS that
  mechanism.
- **Everything the router itself sends mid-turn** (tool-step
  classification skip, compaction summaries, delegation) already runs on
  its own deliberately chosen model via the sub-call scope.

Why a main-thread switch mid-turn does not pay:

- The context is largest exactly then (every tool step grows it), so the
  one-time uncached re-read hits at the most expensive moment of the turn.
- The remaining horizon is short: a turn has at most ~20-25 steps, usually
  fewer. At 100k context the switch costs ~$0.14 once (GLM-class input
  price) while the per-step saving is ~$0.01-0.02 — break-even only after
  ~9-14 further steps FROM the switch, which the turn rarely has left.
  Best case (expensive base model, large price gap, long turn) is
  borderline; on the usual cheap-model sessions it never pays.
- A mid-task model switch is a brain transplant: the model holds a plan,
  open tool assumptions, partial reasoning. The sub-call-scope bug class
  (live incident 2026-11-03, fixed through PR #86/#129 and the PR #199
  sub-call guard) shows how fragile those state assumptions are — a
  main-thread mid-turn switch would reopen them in the core path.

Where the information that would justify a switch belongs: the next turn
boundary — which follows an agent loop soon anyway, and where a switch is
free whenever the cache is already cold (the condition above). A possible
later lever: the observe_momentum quality observations could justify an
up-/downgrade AT the turn boundary; mid-turn it is too late to matter.

## Options

- **A — status quo.** Category changes already switch; drift is handled by
  the 5c fresh-session suggestion at cold-cache moments. No new mechanism.
- **B — mid-session downgrade suggestion (5c-style).** At a turn boundary,
  when the session's remaining context is large, the cache is already cold
  (or the amortization estimate is clearly positive) and the recent turns
  classify into a cheaper group, emit a one-line suggestion: "switching to X
  would save ~$Y from here; it restarts the cache". Owner decides per
  suggestion; at most one per cooldown window. No automatic behavior.
- **C — automatic downgrade.** Same conditions as B, but the router switches
  by itself. Strongest effect, but the router starts moving the user between
  models mid-conversation (answers may change style/quality mid-thread) —
  the exact class of surprise the owner rejected for compaction.
- **D — manual command.** A `/router` command ("switch to X now") that
  executes the switch cleanly (target, warm-target reset, log entry). No
  automatic behavior at all.

## Recommendation

B, gated on the 5b cache state (only suggest when the cache is cold anyway or
the amortization estimate is clearly positive), downgrade only. It reuses the
5c suggestion plumbing (one suggestion per cooldown window, turn boundary
only) instead of adding a second proactive channel. If ever.

## Open decisions (owner)

- Whether to pursue this at all, and if so: B (suggestion) vs C (automatic)
  vs D (manual command).
- Whether "downgrade" means group-level (category) only or also
  within-group model changes.
