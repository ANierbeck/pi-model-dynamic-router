# ADR-0008: Learned model blocklist (auto-block from observed permanent failures)

**Status**: Accepted (2026-09-26). **Implemented 2026-09-27**: Tier 1 and
Tier 2 (points 1–7 below, see "Implementation").
Thresholds confirmed by the owner: Tier-1 blocks on first occurrence,
Tier-2 promotes at N=5 (zero successes, spanning ≥ 1h), blocklist TTL is
7 days. The static `exclude.models` list from `913d53e` stays as the manual
override (point 7).

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
- **404 "No endpoints found for X"** — the model was decommissioned.
  Permanent *until OpenRouter re-lists it*.
- **404 "This model is unavailable for X. The paid version is available
  now"** — the free variant was retired (38 log lines on 2026-09-26).
  Permanent for the `:free` ref.

Not every OpenRouter 404 is a property of the model: **404 "No endpoints
found that support tool use"** (59 log lines, e.g. `z-ai/glm-5.2:free`)
fails only for requests that carry tools. The same model can still answer
tool-free classifier and reader calls, so this is a property of the
*request*, not the model (see "Request-dependent signatures" below).

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
  `router-config.json`. The stopgap (commit `913d53e`) filled it with the 14
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
  `classifier_no_schema` 24h TTL in commit `b04cd87`.)
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

What we shipped in `913d53e`. Hand-curated refs in `router-config.json`.

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
| 404 + `No endpoints available matching your guardrail restrictions` | permanent (workspace guardrail, older wording) |
| 404 + `No endpoints found for <model>` | permanent (decommissioned) |
| 404 + `This model is unavailable for <model>. The paid version is available now` | permanent (free variant retired) |
| 404 + `No endpoints found that support tool use` | **request-dependent** — never a model block |
| 429 / `rate limit` / `spend limit reached` | **transient** — never block |
| timeout / ECONNRESET / empty stream | **transient** — never block |
| Ollama 404 `model not found` | **never block** — "not pulled yet" is fixed by `ollama pull`, and a 7-day block would outlive the fix |

The catalogue is **scoped per provider**: the OpenRouter rows match only
refs whose provider is `openrouter`. A bare "404 / not found" pattern would
also hit Ollama (and any OpenAI-compatible provider), where the same status
means something different.

**Request-dependent signatures** (tool-use 404 today; context-length or
modality mismatches are the same class) are never promoted to a
model-level block, in Tier 1 or Tier 2. Blocking would also remove the model
from tool-free classifier and reader calls where it works. If these burn
too many hops, the right fix is capability-aware candidate filtering
(skip models without tool support for tool-carrying requests). That is
out of scope for this ADR.

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
`reason: unknown-signature (N× <sig>)`. A single success clears the streak.

Tier 2 **cannot** reuse `model-health.ts`'s counter. That streak resets
after 15 minutes (`HEALTH_DECAY_MS`), and after 2 failures (`UNHEALTHY_AT`)
the model is demoted and tried less often. "5 consecutive failures
spanning ≥ 1 h" would therefore almost never accumulate. Tier 2 needs its
own persisted counter per `(ref, signature)` with no short decay:
`{ count, first_seen, last_seen }`, reset on any success for that ref and
reset when the signature changes. Only the success-clears-streak *idea* is
reused, not the storage.

- **Pros**: immediate + safe for the signatures we know; adaptive for the
  ones we don't, without ever blocking a model mid-transient-burst (the
  zero-successes + time-window guard prevents it).
- **Cons**: two code paths; the Tier-2 threshold (N, window) is a knob that
  needs tuning; slightly more surface area to test.

**Verdict**: **recommended.** Tier 1 covers the observed live incident
exactly (the 403/404 signatures from 2026-09-26) with zero false-positive
risk; Tier 2 means a future unknown-permanent failure mode doesn't require
a code change to eventually stop burning.

## Decision (accepted 2026-09-26)

Adopt **Option D** (hybrid). Concretely:

1. **Observe** failures where they actually surface. The incident's
   403/404s do **not** reject `tryStream`. They arrive as stream results
   with `reason === 'provider_error'` from `consumeWithDetection`
   (`src/stream-orchestrator.ts`, both consumption sites), logged as
   `provider error: 403: {...}`. That result path is the primary hook.
   The `tryStream` catch path and the classifier probe path are secondary
   hooks. A classifier wired only to the catch path would see none of the
   incident failures. Capture
   `{ ref, provider, httpStatus, message, routingStep, ineligibilityReasons }`.
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
4. **Filter at runtime only**: extend `isExcluded` to also drop refs
   present in `cache.model_blocklist` (within TTL). It is already called
   per request from `routing.ts` (`applyExcludes`) and
   `stream-orchestrator.ts`. It must **not** filter inside
   `generateDynamicConfig`. That output is baked into
   `router-config.dynamic.json`, whose group `models` lists act as
   allow-lists for up to 30 days (`isScanCacheValid`). A new block would
   then apply only after the next scan, and an expired block would never
   come back for its re-probe, which breaks the 7-day TTL. Static
   `exclude.models` and the learned list meet in `isExcluded`, so they
   compose instead of competing.
5. **Self-heal** via TTL on the blocklist entry: **7 days** (confirmed by
   the owner 2026-09-26). The classifier analogue uses 24h, but model
   decommissions and guardrails change far less often than Ollama schema
   support, so a longer window is right — and re-probing is cheap, because
   a re-confirmation re-blocks immediately and resets the TTL. On TTL
   expiry the ref is *re-tried once* on the next walk; a re-confirmation
   re-blocks (occurrences++) and resets the TTL; a success clears the
   block.
6. **Surface** via `/router`: a `blocklist` sub-command (or a section in
   the existing status dump) listing each blocked ref with `reason`,
   `code`, `first_seen`, `occurrences`, and time-to-next-reprobe. Never
   silent.
7. **Keep the static list** as a manual override that bypasses the TTL
   (for cases the owner wants blocked *now and regardless*). The
   live-incident 14 refs can stay static, or migrate to learned once the
   system re-observes them — owner's call.
   **Known pitfall**: `deepMergeConfig` (`src/config-loader.ts`) replaces
   arrays wholesale. A user config with its own `exclude.models` silently
   drops the bundled list (observed on the owner's machine 2026-09-26). The
   learned list lives in the cache, so it is immune. Resolved by ADR-0009:
   `exclude.*` arrays are now unioned across config layers.

### Thresholds (confirmed by the owner, 2026-09-26)

- **Tier-1 immediate block**: **block on first occurrence** of a
  known-permanent signature. The signatures are deterministic — the same
  structural response comes back every time — so one observation is
  reliable evidence. The `classifier_no_schema` precedent (commit
  `b04cd87`) blocks on first occurrence for the same reason; no 2×
  confirmation round-trip is burned.
- **Tier-2 promotion threshold**: **5** consecutive same-signature
  failures, **zero** successes, spanning **≥ 1 hour** (not a single
  burst), before an unknown signature is promoted. Tunable later.
- **Blocklist TTL**: **7 days.** Aggressive re-probe beats quiet: the
  common case (block re-confirms immediately) costs one wasted hop per
  week, while a shorter window self-heals faster after a guardrail or
  policy change.

## Implementation (Tier 1, 2026-09-27)

- `src/error-signatures.ts`: provider-scoped signature catalogue
  (`classifyFailure`). OpenRouter only for now: `agentic-harness-gate`
  (403), `workspace-guardrail` (404, both wordings and the
  `ineligibility_reasons` enum), `free-variant-retired` (404),
  `decommissioned` (404 "No endpoints found for"). `no-tool-support` is
  classified as `request` and never blocks. Everything else goes through the
  generic transient/unknown classification described under Tier 2.
- `src/model-blocklist.ts`: `cache.model_blocklist` state (record, TTL check,
  clear, active list).
- Hooks: every `consumeWithDetection` failure with a `detail` text and every
  thrown stream error in `StreamOrchestrator` (main loop and cooldown-collapse
  retry) call `ctx.observeFailure`. The classifier probe feeds its failures
  too, and skips blocked refs when selecting candidates. A new block is logged
  and the cache is saved immediately. `recordOk` clears a block after a
  successful re-probe.
- **Filter location differs from point 4.** The persist path
  (`generateDynamicConfig`) also calls `isExcluded`, so putting the
  blocklist inside `isExcluded` would bake blocks into the persisted config
  and defeat the TTL. The runtime filter sits in `Router.allDiscoveredRefs`
  (live and display) and in the HINT fallback pool instead. The intent of
  point 4 (runtime only) is kept.
- Visibility: `/router blocklist` lists every active block with reason,
  HTTP code, first-seen date, occurrences and time to re-probe. The `/router`
  overview shows a one-line count.
- Tests: `test/model-blocklist.test.ts` (catalogue on the real 2026-09-26
  error texts, state, TTL, clear, router filter),
  `test/blocklist-drivestream.test.ts` (end to end: a 403 blocks the model,
  the next request skips it, the block is persisted; fails without the
  orchestrator hooks), and a probe-selection case in
  `test/classifier-fallback-probe.test.ts`.

## Implementation (Tier 2, 2026-09-27)

- Classification has four verdicts: `permanent`, `request`, `transient`,
  `unknown`. Only `unknown` feeds Tier 2. `transient` covers 429, 5xx,
  rate-limit, overflow and abort text, network and timeout wording, and
  generic upstream or stream-level failures. The unknown signature is
  `<HTTP code or x>:<normalised message>`, with ids, digits, URLs and quotes
  stripped so repeats share one key.
- `cache.model_failure_streaks` counts consecutive failures per model with the
  same unknown signature. The model is blocked at 5 failures spanning at least
  1 h (`reason: unknown-signature`). A success resets the streak, and so does a
  different unknown signature. Known-transient failures neither count nor
  reset. A streak whose last failure is older than the TTL restarts. An
  expired block re-blocks on the first failure with the same signature, as in
  Tier 1.
- Local providers are never promoted: their failures are daemon trouble,
  not model properties.
- Hooks only feed `provider_error` details and thrown stream errors. Overflow
  and repetition details never reach the blocklist.
- Streak updates are persisted whenever the cache is saved (at the latest on
  the next block or scan). A restart can therefore lose a partial streak.
  That errs toward not blocking.

**Calibration against the real log (2026-09-26, 138 distinct provider-error
texts).** Before the catalogue was tightened, these would have fed Tier 2:
- Mistral's bare `422`/`403 status code (no body)`, 33 texts. This is the
  daily quota and resets the next day, so a 7-day block would be wrong. Now
  classified as transient per provider.
- "Connection error.", OpenRouter's "Provider returned error", and stream
  aborts ("finish_reason: error", "stopped with: error", "ended without a
  finish reason", "JSON error injected into SSE stream"). Now transient.
- "does not support tools". Now `request`, from any provider.

What remains `unknown` are mainly Mistral's "Invalid model: …" (400) and a bare
`400 status code (no body)` for models that cannot chat (e.g. OCR). These
are the failures Tier 2 is meant to catch.

## Review corrections (2026-09-27)

- **Classifier probe:** only provider errors (`errorMessage` / error stop, or
  a thrown error) feed the blocklist. A wrong classification means the model
  answered, so it counts as a success and resets the Tier-2 streak.
  Otherwise a model that works for chat could be blocked from every group
  over classifier quality.
- **Account-wide failures:** 401 and auth wording ("invalid API key",
  "unauthorized", "user not found", …) are `transient` with reason
  `account-auth`. They hit every model of a provider and heal when the key
  is fixed, so a per-model block would outlive the fix.
- **Manual unblock:** `/router blocklist clear [provider/model]` removes one
  block or all blocks, including Tier-2 streaks.

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
- **`classifier_no_schema` (commit `b04cd87`)** is the direct
  precedent for the "mark-in-cache + TTL + skip + self-heal" shape;
  this ADR generalises it from "one backend rejects structured output"
  to "one backend rejects the request entirely."
