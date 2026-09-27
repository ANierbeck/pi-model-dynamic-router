# Cloud-First Routing (Local Ollama as Last Resort) — Design

## Problem

Every classified turn currently hits the local Ollama daemon first
(`DEFAULT_MODEL = 'mistral-nemo:latest'`, `content-classifier.ts:190`), and
five model groups (`trivial`, `simple`, `scout`, `bulk_reader`,
`code_writer`) rank local models ahead of or level with cloud models via
`billing_preference: "strict_local" | "local_first"`. On this machine that
means Ollama loads a model (`ollama ps` confirms `gemma2:2b` at 100% GPU)
on nearly every interaction, pinning the GPU/CPU even for routine chat
turns. The owner (Achim) no longer trusts the local daemon's stability
(recurring MLX wedge incidents, 2026-09-25/26) and wants cloud models to be
the default path, with local models reachable only when every cloud option
has failed.

## Decision 1 — Classifier chain: cloud primary, Ollama last resort

**Current order** (`classifyPrompt`, `src/content-classifier.ts`):
1. `ollama/mistral-nemo:latest` (primary)
2. `ollama/gemma2:2b` (fallback)
3. Cloud fallback chain — **only reached if 1+2 both fail or Ollama is
   unavailable/wedged**

**New order:**
1. Cloud fallback chain (already implemented, gated by
   `classifier_cloud_fallback: true` in `router-config.json`, currently
   wired to run *after* Ollama):
   a. Probe-verified cached candidates (`getCachedFallbackModels`)
   b. Lazy probe / discovery (`selectClassifierCandidates`)
   c. Static heuristic fallback (`allowStaticFallback`)
2. `ollama/mistral-nemo:latest` → `ollama/gemma2:2b` — **only if the entire
   cloud chain above throws/returns nothing**

No new cloud infrastructure is needed — `allowCloudFallback`,
`pinnedCloudModel`, `getCachedFallbackModels`, and
`selectClassifierCandidates` already exist and are already enabled via
config. This is a reordering of existing, tested code paths, not new
functionality.

The existing Ollama availability/wedge guard
(`isProviderWedged`/`isOllamaAvailable`) stays as-is; it simply moves to
gate the *last-resort* branch instead of the primary one.

## Decision 2 — Two new `billing_preference` modes

**Current modes** (`src/routing.ts:666-700`, `src/types.ts:88`):
- `strict_local`: local(2) → free(0) → sub(1) → payg(3)
- `local_first`: free(0) ≈ local(2, rank 0.5) → sub(1) → payg(3)
- `default`: free(0) → sub(1) → payg(3), local unranked (falls through to
  cost/gdpval tiebreakers)

**New modes:**
- `cloud_first`: free(0) → sub(1) → payg(3) → **local(2) always last**.
  Replaces `local_first` on `scout`, `bulk_reader`, `code_writer`.
- `local_before_payg`: free(0) → sub(1) → local(2) → payg(3). Replaces
  `strict_local` on `trivial`, `simple` — keeps a free local fallback for
  the cheapest, most latency-sensitive prompts without ever paying PAYG
  rates for a trivial prompt, but no longer puts local *ahead* of free/sub.

`strict_local` and `local_first` are **removed** from the five group
configs but the modes themselves stay implemented in `sortByBillingPreference`
(no call sites left after this change, but removing the modes from the
type/function is a separate, larger refactor not needed for this fix —
YAGNI: leave the working, tested code alone).

## Files touched

- `src/content-classifier.ts` — reorder `classifyPrompt`'s try sequence.
- `src/routing.ts` — add `cloud_first` and `local_before_payg` branches to
  `sortByBillingPreference`.
- `src/types.ts` — extend the `billing_preference` union.
- `router-config.json` — `trivial`/`simple` → `local_before_payg`;
  `scout`/`bulk_reader`/`code_writer` → `cloud_first`.
- Tests: `test/billing-preference.test.ts` (new describe blocks for the two
  new modes), classifier ordering tests (new/adjusted in
  `test/classifier.test.ts` or `test/classifier-fallback-chain.test.ts`).

## Out of scope (tracked separately)

- HINT mechanism regression (Achim reported 2026-09-27, not yet analyzed) —
  separate, independent bug, tracked in memory
  (`todo.hints-broken.2026-09-27`).
- Ollama provider-health watchdog narration ("restart ollama") — ADR-0008
  follow-up (c), unrelated to routing order.
- `strict_local`/`local_first` code removal — YAGNI, no call sites left but
  not required to ship this fix.
