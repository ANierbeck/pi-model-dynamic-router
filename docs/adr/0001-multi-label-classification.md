# 0001 — Multi-label classification

## Status

Accepted (2026-08-29) — Option B.

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

**Recommendation: Option B** (additive secondary category, max-tier
escalation only). It's the smallest change that actually addresses the
stated gap (mixed-intent prompts undershooting), stays backward compatible,
fails safe on LLM misbehavior, and doesn't require designing a new scoring
system whose behavior would be harder to reason about than the problem it
solves — appropriate given the single-user deployment (Decision Drivers).

Option A (do nothing) is the fallback if the user judges the escalation
logic already sufficient and doesn't want to touch the classifier prompt at
all right now.

**Confirmed by user (2026-08-29): Option B.** Rationale matches the
recommendation above — smallest change that addresses the actual gap,
stays backward compatible, and doesn't require designing a new scoring
system the single-user deployment doesn't need.

## Consequences

If B is accepted:

- `ClassificationResult` gains an optional field; `isValidClassification()`
  needs to accept-but-not-require it.
- `index.ts`'s dynamic-group resolution needs a `Math.max`-by-GDPval-floor
  step instead of a single `getGroupForCategory()` call.
- The classifier's LLM prompt needs one new sentence describing when to set
  `secondary_category` (keep it optional/rare — most prompts still get one
  label).
- Test coverage needed: LLM returns only primary (today's behavior
  unchanged), LLM returns primary+secondary with secondary MORE expensive
  (escalates), LLM returns primary+secondary with secondary CHEAPER
  (primary wins, no downgrade), and a malformed `secondary_category` value
  (ignored, falls back to primary-only — never crashes the whole
  classification).
