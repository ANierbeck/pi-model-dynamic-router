# Plan: `/router cost` (audit depth) + `/router errors` (status-line-correlated error history)

**Date:** 2026-09-27
**Status:** approved by owner (brainstorming answers 2026-09-27 evening)
**v1.6.0 scope:** both features are v1.6.0 items per owner.

## Owner decisions

1. **`/router cost` — full audit depth:** per-model session table (ALL
   models, not top-5): requests, in/out tokens, marginal cost, billing tier
   with sunk marker; plus persistent token windows 1d/7d/30d from `usage_log`
   with a blended cost estimate.
2. **`/router errors` — correlatable with the status line:** "when the
   status line shows three errors, I want to see exactly those three."
   The status-line counter and the command must come from ONE source of
   truth. pi's extension status API (`ctx.ui.setStatus(key, text)` —
   footer line, cleared by empty text) is currently unused; the router
   becomes its owner for error counts.
3. **Error scope: main-session streams only.** Probes/scans/classifier
   chains must not flood the buffer (the free-model 429 wave is noise).
   `recordStreamFailure` is the single recording site for main-session
   stream failures (called only from the 4 orchestrator sites) — the
   blocklist/probe path (`recordBlocklistFailure`) is separate and stays
   out.

## Feature 1: `/router cost`

### Current state
`costTracker.formatSummary()` shows uptime, total cost/tokens, top-5 models
by accumulated cost. After the cost audit we can show much more: per-model
in/out tokens, requests, marginal cost, billing tier (free / subscription
[sunk] / local / payg), and persistent windows.

### Changes

1. **`src/cost-tracker.ts`**
   - `CostMetrics` gains `tokensByModel: Record<string, { in: number; out: number }>`;
     `trackRequest()` fills it. **Review I2:** the five selection-time call
     sites passed hardcoded `1000/500` tokens — fabricated audit data (and
     always were, for the marginal-cost column too). They are REMOVED;
     tracking happens once per COMPLETED turn in `turn_end` with the
     provider-reported `usage.input/output` (turns without reported usage are
     not tracked rather than fabricated).
   - New `formatCostReport(deps)` replacing the `/router cost` output:
     - Session section: ALL models sorted by marginal cost desc:
       `Req | In/Out | Marginal $ | Tier` — tier from `billingTier(ref)`
       with `(sunk)` marker for subscription (virtual sunk-cost prices, not
       real spend; the audit's 0.0000015 convention).
     - Windows section keyed by `windowsAll()` — the refs that actually have
     logged usage (session models ∪ usage_log refs), so the persistent half
     is visible even right after a restart with an empty session table
     (review I1: per-model lookups over requestsByModel hid it). Blended
     estimate `≈ tokens × (pIn + pOut) / 2 / 1M`, labeled `≈` — usage_log has
     only total tokens per request. Unknown price → tokens only.
     - Totals line and uptime stay.
   - `formatSummary()` (legacy) stays for the scheduled/exit file summary.
2. **`index.ts`** — `/router cost` handler: assembles deps
   (`getUsageAll` windows, `billingTier`, price lookup), notifies the report.
   - **Review I1 (writer fix):** the `turn_end` usage_log writer previously
     keyed by `curModel` — the VIRTUAL group ref (`standard/standard`) in
     group sessions, which real-ref window lookups never match — and stored
     an output-only `text.length/4` approximation. Now it uses the factual
     per-turn stream ref (`router.getCurModel(turnStart)`) and REAL
     `usage.input + usage.output` (text/4 only as fallback).

## Feature 2: `/router errors` + status-line counter

### Design — correlation by construction

- **Ring buffer** `cache.session_errors` (persisted in scan-cache, survives
  restarts): entries `{ ts, ref, reason, detail?, consequence }`, FIFO cap 50.
- **Push site:** `recordStreamFailure()` (index.ts) — the existing single
  recording site for main-session failures. Every call pushes one entry:
  - consequence `cooldown` (+ remaining seconds) when hard-limited,
  - `soft backoff` otherwise.
  - `detail` = the error text already threaded there (≤120 chars, trimmed).
- **Status line (review C1 corrected the display path):** the router
  REPLACES pi's built-in footer via `ctx.ui.setFooter(...)` — and the
  built-in footer is the ONLY renderer of `ctx.ui.setStatus` extension
  statuses. So the counter is rendered as a PART of our own footer:
  `⚠N err` next to `⛔rlN`, derived in the footer's `render()` from the SAME
  buffer (entries with ts >= sessionStart). `ctx.ui.setStatus` is kept
  purely as an immediate re-render trigger (captured only from a ctx that
  has it — a subagent's headless ctx must not null the main session's
  updater), with the 30s footer tick as fallback.
- **Anchor reset rule (review M2):** in-process subagent sessions re-fire
  `session_start` with reason 'startup' (pi-subagents child-session.js),
  which would silently drop the main session's errors from the count.
  The anchor resets ONLY on real user session switches (`new`/`resume`/
  `fork`) and the process's first session_start; `reload` and subagent
  starts keep it.
- **Push-site seam (review I3/I4):** the consequence decision lives in the
  testable `recordSessionErrorFromFailure()` (src/session-errors.ts):
  `cooldown <N>s` for hard limits, `key rotated` when recordLimit rotated
  (NO cooldown is set on the ref in that case — a naive `cooldown 0s`
  would poison incident analysis), `soft backoff` otherwise. Persistence
  is debounced (2s coalescing) — saveCache is a synchronous full-file
  write and a 17-candidate chain burn must not trigger 17 writes.
- **Command** `/router errors [n]` (default 15):
  - Headline: `N errors this session` — exactly the status-line count.
  - Table: `HH:MM:SS | model | reason | consequence | detail snippet`.
  - Entries older than `sessionStart` below a divider
    `--- earlier (persisted history) ---` (diagnosis context without
    breaking correlation).
- **Wire-up:** registerCommand completions (`errors`, `errors <n>`),
  handler branch; `SessionError` type in src/types.ts + optional
  `session_errors` on the cache type.

### Non-goals
No `errors clear` (FIFO self-trims at 50); no probe/scan/classifier errors;
no new Config keys; blocklist/cooldown commands unchanged; `/router cost`
file-summary behavior (logSummary) unchanged.

## Tests (TDD — red first)

- `test/cost-report.test.ts`
  - per-model in/out token tracking (trackRequest → tokensByModel)
  - full report: ALL models (not top-5), sort by marginal cost, tier labels
    incl. `(sunk)`, totals line
  - windows with empty session but persistent usage (restart case, review I1)
  - completely empty → honest empty state
  - blended estimate math; unknown price → tokens only
- `test/usage-windows.test.ts` (added in review round — the plan's
  originally promised boundary test)
  - 1d/7d/30d boundaries from a synthetic usage_log via the REAL
    getUsage/getUsageAll
  - ref-space contract: real model refs, never the virtual group ref
- `test/session-errors.test.ts`
  - seam: cooldown / `key rotated` (I4) / soft backoff consequence labels,
    detail threading + whitespace collapse
  - FIFO cap 50 (oldest dropped), 120-char trim, Array.isArray guard
  - status count = entries with ts >= sessionStart (entries from an
    earlier "process" do not count)
  - probe path (`recordBlocklistFailure`) does NOT push
  - persistence round-trip (CacheManager save → fresh load keeps the buffer)
  - command formatting: session section headline count matches buffer,
    divider before older entries

## Verification
`npx vitest run` green, `npx tsc --noEmit` clean, `npm run build` +
import smoke, reviewer pass with evidence files, then commit + push
(normal flow; v1.6.0 release itself remains a separate owner decision).

## Review round 2026-09-27 (fresh-context reviewer, report in
`/tmp/router-review-2026-09-27b/review-report.md`)

Verdict CHANGES REQUESTED → all findings fixed (AGENTS.md §1/§7):
- **C1** status line never rendered (router footer replaces the built-in,
  the only renderer of setStatus) → footer part `⚠N err` added.
- **I1** windows structurally all-zero (usage_log keyed by virtual group
  refs + output-only token approximation) → factual per-turn ref + real
  usage tokens at the writer; `windowsAll()` keyed by refs with usage.
- **I2** In/Out column fabricated (all trackRequest sites hardcoded
  1000/500) → selection-time calls removed; real per-turn usage tracked.
- **I3** four promised wiring tests missing → seam + probe-exclusion +
  persistence round-trip + usage-windows boundary tests added.
- **I4** `cooldown 0s` on key rotation → `key rotated` label.
- **M1** saveCache per failure → 2s debounce. **M2** subagent session_start
  reset the anchor → reset rule (new/resume/fork/first only).
  **M3** Array.isArray guard. **M4** whitespace collapse in details.
  **M5** usage string now lists errors + cooldowns.
- **K1** SessionError type moved to the Cache section. **K2** dispose()
  clears the midnight timer in both cost test files. **K3** column
  alignment reworked.

Also changed in the same writer pass (same defect family, review I1):
`updateMetrics`/`recordOk` in turn_end now receive the factual per-turn ref
instead of the virtual group ref. The orchestrator's own `recordOk` calls
already used real refs, so healing behavior is unchanged; the turn_end
call on a group ref was a no-op for real-ref state.

## Review round 2 (fresh-context reviewer, report in
`/tmp/router-review-2026-09-27c/review-report-round2.md`)

All 13 round-1 findings verified FIXED. One NEW Important finding + 2
small ones, all fixed in the same round:
- **Finding 1 (Important)**: the buffer missed the main loop's SOFT
  failures — only the 4 rate-limit-shaped sites routed through
  recordStreamFailure; the generic provider_error branch, stream-open
  failures, the catch handler, repetition_loop, truncated_length, context
  overflow and the force-retry softs called recordSoftFailure DIRECTLY.
  During exactly the cascades the feature diagnoses (422/timeout waves) the
  counter read ⚠0 err. Fix: all 12 sites route through the seam now
  (recordSoftFailure became internal to it; the orchestrator ctx interface
  member was removed as dead). A 429-shaped error text at those sites now
  correctly escalates hard — consistent with the 422-fix semantics.
  Regression: test/session-errors-wiring.test.ts drives the REAL extension
  through a bare 422 provider_error and asserts the persisted buffer entry
  with consequence 'soft backoff' (red before the fix, green after).
- **Finding 2 (Minor)**: the promised Array.isArray-guard regression test
  added (corrupted cache repaired, not thrown).
- **Finding 3 (Cosmetic)**: the price-map mock lives inside beforeEach
  (describe-body-level implementations survive clearAllMocks only by
  accident).
- K3 residue: fmtK renders ≥1M tokens as 'M'; Marginal column widened to
  the 6-decimal cost width.
- Harness lesson (test infrastructure): pi.on registers MULTIPLE handlers
  per event; a `map[event] = handler` test harness keeps only the last one —
  the router's second session_shutdown handler (ctx-null) silently dropped
  the persistence handler. The wiring test stores ARRAYS and fires them all.
