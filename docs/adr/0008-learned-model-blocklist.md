# ADR-0008: Learned model blocklist (auto-block from observed permanent failures)

**Status**: Proposed (2026-09-26). Awaiting the owner's pick on the Tier-2
policy and the self-heal TTL. The static `exclude.models` list shipped in
commit `fce3f2b` is the interim stopgap this ADR is meant to replace for the
general case (see Option A).

## Context

OpenRouter answers some free-tier model requests with **permanent structural
failures** — responses that never heal by retrying, because the cause is not
load or a transient outage but a *property* of the setup:

- **403 "only available on agentic harnesses"** — OpenRouter gates the
  model's only endpoints behind recognized agentic-harness apps. Pi's
  requests never pass that gate. Permanent *for this client identity*.
- **404 "free-model-training-violation"** — the user's workspace guardrails
  (a deliberate data policy) exclude the endpoint. Permanent *for this
  account's guardrails*.
- **404 "model not found / does not exist"** — the model was decommissioned.
  Permanent *until OpenRouter re-lists it*.

Live evidence 2026-09-26 (`router.log`): the two `thinkingmachines/inkling:*`
models alone burned ~750 candidate attempts in a single evening (319 + 174
counted lines). Every walk of a fallback/reader chain re-burned the same
guaranteed failures, because nothing in the router distinguished a permanent
structural dead-end from a transient one. The existing failure-recovery
machinery was built for the *transient* case and treats every failure the
same way:

- `src/model-health.ts` — per-model consecutive-failure tracking, 15-minute
  decay (`HEALTH_DECAY_MS`), demotes a model within its group after
  `UNHEALTHY_AT = 2` consecutive fails. A model is **never removed** — it
  returns to position 1 as soon as its failures decay. This is exactly right
  for flaky-but-recoverable models and exactly wrong for structurally dead
  ones: the same model re-enters the candidate pool every 15 minutes and
  fails again on the next walk.
- `src/exclude.ts` — global exclusion rules (`exclude.providers`,
  `exclude.models` globs, `exclude.paid_models_from`), applied in
  `generateDynamicConfig` *before* per-group filtering. A clean, single
  filter point — but the `models` list is hand-maintained in
  `router-config.json`. The stopgap (commit `fce3f2b`) filled it with the 14
  refs observed in the live incident. The owner's response on seeing the
  stopgap: *"I didn't actually want the blocklist to be static. How can the
  system learn and build a blocklist on its own?"*

This ADR is that question's answer.

## Decision Drivers

- **No hardcoded model names (reuse ADR-0006's driver).** A hand-maintained
  list works only for the user who wrote it and rots when OpenRouter's
  catalogue changes. The system must produce the list from what it observes.
- **Distinguish permanent from transient — and be right about it.** A false
  positive (blocking a model that's merely rate-limited this minute) is a
  real cost: the model may be the cheapest good option and silently
  disappears from every group. A false negative (re-trying a structurally
  dead model every walk) is the status quo we're fixing. The asymmetry
  favours *not* blocking unless we're confident.
- **Self-healing.** Permanent-for-this-setup is not permanent-forever:
  guardrails get edited, models get re-listed, OpenRouter adds new harness
  integrations. A blocked model must come back for a re-probe eventually,
  without a human editing the config. (Same principle as the
  `classifier_no_schema` 24h TTL in commit `d3a51e3`.)
- **Visible, not silent.** A model silently disappearing from candidate
  lists is the worst possible failure mode for debugging ("why isn't X
  routing to inkling anymore?"). Blocked status and *reason* must be
  queryable — `/router` should show the learned blocklist.
- **Single-user deployment.** No multi-tenant fairness, no shared state,
  no need to be defensive about other users' guardrails. We can be
  opinionated about "this account's observed reality is the truth."
- **Existing patterns to reuse, not re-invent.** `model-health.ts` already
  has failure recording + success-clears-streak; `exclude.ts` is already
  the single filter point; the `classifier_no_schema` cache field already
  proves the "mark in cache + TTL + skip" shape works for a closely
  analogous problem.

## Options Considered

### A — Keep the static `exclude.models` list (the stopgap)

What we shipped in `fce3f2b`. Hand-curated refs in `router-config.json`.

- **Pros**: zero new code; already works; fully auditable (the list is
  literally in the config file); no risk of a learning heuristic
  misclassifying a transient burst.
- **Cons**: doesn't learn. Every new permanent-dead model re-burns
  guaranteed failures until a human notices, greps the log, and adds the
  ref. Rots as OpenRouter's catalogue and the user's guardrails change.
  This is the option the owner explicitly rejected.

**Verdict**: accepted *as the interim only*, to be kept as a manual override
on top of whatever learned mechanism wins below — not as the long-term
answer.

### B — Pure statistical learning (count failures, block after N)

Observe failures per ref; once a ref accumulates N consecutive failures
(without a success), promote it to the blocklist. Essentially: make
`model-health.ts` *permanent* instead of 15-minute-decaying, and have
`isExcluded` honour it.

- **Pros**: fully generic — learns any failure mode, known or unknown, no
  signature catalogue to maintain; reuses the existing failure-counter
  plumbing almost verbatim.
- **Cons**:
  - **Cannot tell "flaky" from "dead".** A model that returns an empty
    stream 60% of the time looks statistically similar to one that 403s
    every time; the former may still be the best cheap option, the latter
    is pure waste. A pure count blurs this.
  - **Slow + false-positive-prone.** N must be large enough to survive a
    rate-limit window (OpenRouter spend limits reset in ~60s but can last
    longer) or we block healthy models mid-burst. Large N means many
    guaranteed-failure hops before the block kicks in — the exact waste
    we're trying to stop.
  - **No reason.** "blocked because it failed 5×" tells the user nothing
    about whether to edit a guardrail or wait for OpenRouter.

**Verdict**: rejected as the *sole* mechanism. Its counting primitive is
useful for the unknown-signature tier (Option D).

### C — Deterministic error-signature classification

Parse each observed failure's HTTP status + body. Match against a small
catalogue of **known-permanent signatures**; on a match, block immediately
with the parsed reason. Examples:

| Signature | Verdict |
|---|---|
| 403 + `only available on agentic harnesses` + `failed_routing_step: "Gate Free Endpoints by Agentic Harness"` | permanent (OR-side gate) |
| 404 + `ineligibility_reasons[].reason: "free-model-training-violation-by-guardrail"` | permanent (workspace guardrail) |
| 404 + `model not found` / `does not exist` | permanent (decommissioned) |
| 429 / `rate limit` / `spend limit reached` | **transient** — never block |
| timeout / ECONNRESET / empty stream | **transient** — never block |

- **Pros**:
  - **Right on the first try.** These signatures are deterministic — the
    same structural response comes back every time — so one observation is
    reliable evidence. No N-rounds-of-burned-hops warm-up.
  - **Auditable + actionable reason.** `blocked: agentic-harness-gate` /
    `blocked: workspace-guardrail-training-violation` tells the user
    exactly where to look (the OpenRouter guardrails page).
  - **Safe.** Transient signatures (rate limit, timeout) are explicitly
    *never* blocked here, so a burst can't trigger a false permanent block.
- **Cons**:
  - **Maintenance.** A new permanent failure form (some future OpenRouter
    policy) needs its signature added by hand. Missed → falls back to
    re-burning until someone notices. (Mitigated by Option D's Tier 2.)
  - **Parse fragility.** OpenRouter could reword the message. Mitigation:
    match on the stable `metadata.failed_routing_step` /
    `ineligibility_reasons[].reason` enum values where they exist, fall
    back to substring on the message.

**Verdict**: this is the **core** of the recommended design — it directly
answers "how does the system *know* a failure is permanent" without
statistics guessing at it.

### D — Hybrid: deterministic Tier 1 + statistical Tier 2 (recommended)

Tier 1 = Option C (immediate block on known-permanent signatures, with
reason). Tier 2 = a cautious statistical backstop for *unknown* failure
signatures: a ref that fails N consecutive times with the **same** unknown
signature, spanning a minimum time window (so it isn't a single burst),
with **zero** successes in between, is promoted to the blocklist tagged
`reason: unknown-signature (N× <sig>)`. A single success clears the streak
(reuse `model-health.ts`'s success-clears-streak).

- **Pros**: immediate + safe for the signatures we know; adaptive for the
  ones we don't, without ever blocking a model mid-transient-burst (the
  zero-successes + time-window guard prevents it).
- **Cons**: two code paths; the Tier-2 threshold (N, window) is a knob that
  needs tuning; slightly more surface area to test.

**Verdict**: **recommended.** Tier 1 covers the observed live incident
exactly (the 403/404 signatures from 2026-09-26) with zero false-positive
risk; Tier 2 means a future unknown-permanent failure mode doesn't require
a code change to eventually stop burning.

## Decision (proposed — pending owner confirmation)

Adopt **Option D** (hybrid). Concretely:

1. **Observe** failures where the router already observes them — the
   stream-orchestrator's `tryStream` catch path (and the classifier probe
   path, for symmetry with `classifier_no_schema`). Capture
   `{ ref, httpStatus, message, routingStep, ineligibilityReasons }`.
2. **Classify** into `permanent` / `transient` / `unknown` via the Tier-1
   signature catalogue (a small module, e.g. `src/error-signatures.ts`,
   so the signatures are reviewable in one place).
3. **Persist** permanent + promoted-unknown blocks in a new cache field:
   ```ts
   model_blocklist?: Record<string, {
     reason: string;            // 'agentic-harness-gate' | 'workspace-guardrail' | ...
     code: number;              // observed HTTP status
     signature: string;         // normalised match key (for Tier-2 dedupe)
     first_seen: number;        // ms
     last_seen: number;         // ms
     occurrences: number;       // re-confirmations after re-probe
   }>;
   ```
   State lives in the cache object (same rationale as `model-health.ts`:
   esbuild bundles some modules twice and module-level state would diverge
   between instances).
4. **Filter** at the existing single point: extend `isExcluded` (or
   `generateDynamicConfig`) to also drop refs present in
   `cache.model_blocklist` (within TTL). One filter point keeps static
   `exclude.models` (manual override) and the learned list in the same
   place — they compose instead of competing.
5. **Self-heal** via TTL on the blocklist entry. **Open question for the
   owner**: 7 days (aggressive re-probe, cheap on the common case where
   the block re-confirms immediately) vs 30 days (quiet, minimal wasted
   re-probes). The classifier analogue uses 24h, but model decommissions
   and guardrails change far less often than Ollama schema support, so
   longer seems right. On TTL expiry the ref is *re-tried once* on the
   next walk; a re-confirmation re-blocks (occurrences++) and resets the
   TTL; a success clears the block.
6. **Surface** via `/router`: a `blocklist` sub-command (or a section in
   the existing status dump) listing each blocked ref with `reason`,
   `code`, `first_seen`, `occurrences`, and time-to-next-reprobe. Never
   silent.
7. **Keep the static list** as a manual override that bypasses the TTL
   (for cases the owner wants blocked *now and regardless*). The
   live-incident 14 refs can stay static, or migrate to learned once the
   system re-observes them — owner's call.

### Thresholds to confirm with the owner

- **Tier-1 immediate block**: on first occurrence of a known-permanent
  signature? Or require 2 confirmations within a short window (one extra
  burned hop, guards against a one-off parse glitch)? The
  `classifier_no_schema` precedent blocks on first occurrence; recommend
  the same — the signatures are deterministic.
- **Tier-2 promotion threshold**: propose **5** consecutive same-signature
  failures, **zero** successes, spanning **≥ 1 hour** (not a single burst),
  before an unknown signature is promoted. Tunable later.
- **Blocklist TTL**: 7d (recommended) vs 30d.

## Consequences

**Makes easier:**
- New permanent-dead models stop burning hops within one observed
  failure (Tier 1) or within the Tier-2 window — no human in the loop, no
  config edit, no log grep.
- `/router blocklist` gives an auditable, reasoned view of *why* each
  non-routing model is non-routing — the most common "why isn't X
  routing?" question becomes answerable in one command.
- The static `exclude.models` list stops growing unbounded; it becomes a
  small manual-override escape hatch rather than the primary mechanism.

**Makes harder / new risks:**
- **A new code path that can suppress a model.** The safeguard is the
  signature catalogue (transient signatures are explicitly *never*
  permanent) + the zero-successes guard on Tier 2 + the TTL re-probe +
  `/router` visibility. A misclassified permanent block self-heals on TTL
  and is visible; a missed permanent block keeps burning (status quo).
  The asymmetry favours the change.
- **Parse coupling to OpenRouter's error format.** Matching on
  `metadata.failed_routing_step` and `ineligibility_reasons[].reason`
  (stable enum-ish values) rather than prose reduces but does not
  eliminate this. Tier 2 is the backstop when a new permanent form
  appears that Tier 1 doesn't recognise.
- **One more cache field to migrate/serialise.** The cache already
  carries `model_health`, `classifier_no_schema`, scan pricing, etc.;
  this adds one more. Existing serialisation paths extend naturally.
- **Test surface.** Needs regression tests for: each Tier-1 signature
  → blocks; each transient signature → never blocks; Tier-2 promotion
  after threshold; success clears streak; TTL expiry → re-probe →
  re-block / clear; `/router` output. Non-vacuous (per AGENTS.md §4 —
  exercise the actual path, not a vacuous assertion).

## Relationship to prior decisions

- **ADR-0006** (probe-based discovery) established the "no hardcoded
  model names, learn from observation" driver; this ADR applies the same
  principle to the *exclusion* side, using observed *failures* rather
  than observed *availability*.
- **ADR-0007 rev (2026-09-20)** established the "state lives in the
  cache object, not module variables" pattern (esbuild double-bundle
  hazard); the blocklist follows it.
- **`classifier_no_schema` (commit `d3a51e3`)** is the direct
  precedent for the "mark-in-cache + TTL + skip + self-heal" shape;
  this ADR generalises it from "one backend rejects structured output"
  to "one backend rejects the request entirely."
