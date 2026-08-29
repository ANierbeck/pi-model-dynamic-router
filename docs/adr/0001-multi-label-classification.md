# 0001 — Multi-label classification

## Status

Accepted (2026-08-29, revised same day) — Option C, with an explicit
mitigation plan for its main risk (see below). Initially B was accepted,
then revisited after the user pointed out a concrete, observed problem B
cannot fix: real usage shows claude-sonnet-5 selected even for simple
tasks, and B can only ever escalate (make routing more expensive), never
correct an overshoot. C is the only option on the table that can route
cheaper when the signal genuinely supports it.

## Context

`classifyPrompt()` (`src/content-classifier.ts`) asks a local LLM to assign
exactly ONE category to a prompt, from a fixed 9-value enum (`trivial`,
`simple`, `code_simple`, `standard`, `code_complex`, `design`, `planning`,
`exploration`, `fallback`). `CATEGORY_TO_GROUP` then maps that single
category 1:1 to a routing group (`scout`/`operational`/`tactical`/etc.),
which determines the GDPval floor of the model that answers the prompt.

A prompt that genuinely spans two categories — e.g. "design a caching
strategy for this endpoint AND implement it" (`design` + `code_complex`) —
is forced into whichever single label the LLM judges strongest. There's no
mechanism today to route based on "this needs BOTH good design judgement
and precise code generation."

Existing mitigations that already reduce the practical impact of this gap:

- `applyEscalationLogic()` re-checks the resolved tier against the
  previously-used model's tier and escalates/de-escalates on mismatch — this
  catches some cases where the single label undershoots the real need.
- `fallback` exists as an explicit "uncertain → use a decent model" category
  for when the classifier itself isn't confident, rather than guessing.
- `min_confidence` gates low-confidence LLM output back to the previous
  turn's category rather than trusting a shaky single label.

So the single-label design isn't naive — it already has guardrails for its
own uncertainty. The question is whether multi-label adds enough routing
precision to be worth the added complexity and new failure surface (a
second field in the LLM's JSON response is a second thing that can be
malformed, hallucinated, or contradictory).

## Decision Drivers

- **Single-user, local deployment.** This is not a multi-tenant service
  routing thousands of prompts/day where a few points of routing precision
  translate into meaningful cost/quality at scale. It's one person's coding
  session. The value of "more precise" routing has a much lower ceiling
  here than in a hypothetical SaaS version.
- **Classifier robustness matters more than classifier nuance.** The
  existing code already has to defensively handle malformed JSON, invalid
  categories, and `<think>` blocks leaking into output from reasoning
  models (`gemma4` family). Every additional field in the expected response
  shape is another way for a already-fragile local-LLM JSON contract to
  break.
- **Backward compatibility with `CATEGORY_TO_GROUP`.** Any change should not
  require every existing single-label call site (compaction routing, static
  fallback, HINT detection) to be rewritten.
- **Cost of a wrong routing decision here is small and self-correcting.**
  Cooldowns, escalation, and the fallback cascade already recover from a
  suboptimal model choice within a turn or two — this isn't a one-shot,
  high-stakes decision the way e.g. a financial transaction router would be.

## Options Considered

### A — Do nothing (status quo)

Keep single-label classification as-is.

- **Pros:** Zero implementation/maintenance cost. No new failure surface.
  The escalation-logic safety net already catches the worst cases of an
  undershot category.
- **Cons:** Genuinely mixed-intent prompts still get force-fit into one
  label; no path to improve this later without picking one of the options
  below eventually anyway.

### B — Additive secondary category, take the max tier (recommended)

Add an optional `secondary_category?: ClassificationResult['category']`
field to the LLM's JSON response schema. When present, resolve BOTH
categories to groups via the existing `CATEGORY_TO_GROUP` map and route to
whichever group has the higher GDPval floor (i.e. never downgrade based on
the second label, only escalate).

- **Pros:** Small, additive, backward-compatible — every existing call site
  that doesn't pass/expect `secondary_category` keeps working unchanged.
  Reuses `CATEGORY_TO_GROUP` as-is (no new mapping table). Fails safe: if
  the LLM omits or hallucinates the field, behavior degrades to today's
  single-label routing, not to an error.
- **Cons:** Still not "true" multi-label — no weighting, no more than 2
  labels, always escalates (never optimizes toward a cheaper combined
  route). Doesn't help if the RIGHT answer for a mixed prompt is sometimes
  "route cheaper because the design part is trivial," only "route more
  expensive because SOME part needs precision."

### C — Full multi-label with weighted/ensemble routing

Ask the LLM for a list of `{category, weight}` pairs; replace
`CATEGORY_TO_GROUP`'s 1:1 lookup with a scoring function that picks a group
based on weighted category mix (e.g. a weighted-average GDPval floor, or a
rule table keyed by category combinations).

- **Pros:** Most expressive — could in principle route more precisely,
  including downgrading when a nominally "complex" combination is actually
  low-effort per label.
  Only worth building if there's evidence single-label + escalation is
  actually producing bad routes in practice.
- **Cons:** Significant new failure surface (weights need validating,
  normalizing, defending against LLM hallucination of implausible weight
  distributions). New scoring function to design, tune, and test — replaces
  a currently simple, well-tested lookup table with something with many
  more degrees of freedom to get subtly wrong. Given the single-user,
  self-correcting context (Decision Drivers above), this is disproportionate
  engineering effort for the likely benefit.

### D — Heuristic secondary signal (no second LLM label)

Instead of asking the LLM for a second category, layer a cheap regex/keyword
heuristic on top of the existing single LLM category (similar in spirit to
`classifyStatically()`'s keyword matching) that can only escalate, never
downgrade, the resolved group — e.g. detect "and implement"/"and build" in
combination with a `design`/`planning` category to bump toward `tactical`.

- **Pros:** No LLM prompt/schema changes at all — zero new JSON parsing risk.
  Deterministic, fast, easy to unit test in isolation.
- **Cons:** Heuristic rules are English-centric and brittle (the classifier
  prompt is explicitly language-agnostic today — "The request may be in any
  language" — a keyword heuristic breaks that guarantee). Adds a second,
  differently-shaped mechanism (regex table) alongside the LLM classifier,
  which is more to maintain conceptually even if each part is individually
  simpler.

## Decision

**Accepted: Option C** (full weighted multi-label, with a bounded scoring
function — see Mitigation Plan below). B was rejected on revisit because it
structurally cannot fix the actual problem: it can only ever escalate
(route to something MORE expensive), never correct an overshoot. Real usage
data shows the opposite failure mode happening in practice — claude-sonnet-5
being selected for tasks that don't need it — which only C, D can address,
and D was already rejected for breaking language-independence. C's downside
(a new, harder-to-audit failure mode: silent misrouting instead of a crash)
is real and is the reason this ADR includes a dedicated Mitigation Plan
rather than accepting the risk implicitly.

## Mitigation Plan for Silent Misrouting Risk

The core risk identified in "Options Considered" is that a weighted scoring
function can quietly route to the wrong group with no error thrown — unlike
B (which only ever escalates, so the worst case is "too expensive, never
too weak") or a crash (which is at least visible). This plan bounds that
risk instead of accepting it on faith:

1. **Bounded output space — no interpolation.** The scoring function only
   ever resolves to one of the groups actually implied by the LLM's
   returned labels (via the existing `CATEGORY_TO_GROUP` map) — it never
   synthesizes a new GDPval floor. This keeps every possible outcome a
   real, already-configured, already-tested group.
2. **Strict validation, fail-safe on malformed output.** Weights must be
   numeric in `[0,1]`; if they don't sum to ~1 (±0.15), renormalize; if
   that's not possible (missing/zero/garbage), fall back to primary-label-
   only behavior — i.e. today's routing, never a crash, never an
   arbitrary/undefined resolution. `labels[]` is capped at 3 entries to
   bound the parsing/hallucination surface.
3. **Confidence-gated downgrades — the main lever.** The scoring function
   may only resolve to a CHEAPER group than the dominant label alone would
   give when BOTH: the dominant label's weight ≥ 0.7, AND the overall
   `confidence` field ≥ `min_confidence` (already an existing config
   value). Any less-confident or more-evenly-split distribution falls back
   to escalate-only behavior (identical to what B would have done) — so C's
   "can downgrade" capability is only ever exercised when the signal is
   genuinely strong, not on every ambiguous call.
4. **Full auditability via existing logging.** `appendRawLog()` (already
   called at every dynamic classification decision) is extended to record
   the full label/weight vector and which gate (confidence-gated downgrade
   vs. escalate-only fallback) fired — e.g.
   `labels=[code_simple:0.8,design:0.2] confidence=0.85 → group=simple (downgrade, gate passed)`.
   "Why did it route here" stays a direct log read, not a mystery — this
   directly answers the "harder to explain" con from Options Considered.
5. **Shadow mode before trusting it in production.** New config flag
   `multi_label_downgrade_enabled` (default `false`). While `false`: labels
   are parsed, scored, and logged as normal, but the ACTUAL routing
   decision still uses escalate-only logic — the log shows what C WOULD
   have chosen vs. what actually happened, with zero behavior change. Only
   flip to `true` after reviewing a representative window of shadow logs.
   This is a config flag, not a code path — reverting is a one-line change,
   not a redeploy.
6. **Existing escalation logic remains a second safety net.** Even after
   `multi_label_downgrade_enabled: true`, if a downgrade turns out to be
   wrong and causes visible thrash/loops within a session,
   `SessionEscalation`'s existing reactive loop-detection still bumps the
   tier back up exactly as it does today for any other routing misjudgment
   — a bad downgrade self-corrects within a few turns, it doesn't get stuck
   silently.

## Consequences

- `ClassificationResult` gains a `labels: {category, weight}[]` field
  (capped at 3); the existing single `category` field is kept and derived
  as `labels[0].category` for backward compatibility with every other call
  site (compaction routing, static fallback, HINT detection) that only
  knows about single-label results.
- New scoring function in `src/content-classifier.ts` (weighted GDPval-
  floor lookup over `CATEGORY_TO_GROUP`, with the confidence gate from the
  Mitigation Plan) replaces the single `getGroupForCategory()` call at the
  dynamic-group resolution site in `index.ts`.
- New config: `multi_label_downgrade_enabled` (default `false`, ships in
  shadow mode first), plus reuse of existing `min_confidence`.
- `appendRawLog()` call sites extended with the label/weight vector and
  gate decision.
- The classifier's LLM prompt needs new instructions for the `labels[]`
  shape, including a worked example of a mixed-intent prompt.
- Test coverage needed: single-label passthrough (today's behavior
  unchanged), confident downgrade (gate passes, routes cheaper), low-
  confidence downgrade attempt (gate blocks it, falls back to escalate-
  only), malformed/out-of-range weights (renormalize or fall back to
  primary-only, never crash), shadow mode (`multi_label_downgrade_enabled:
  false` logs the would-be decision but doesn't act on it), and a
  downgrade-then-thrash scenario proving `SessionEscalation` still recovers.
