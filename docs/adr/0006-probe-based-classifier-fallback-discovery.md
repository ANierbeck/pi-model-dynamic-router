# 0006 — Probe-based discovery for classifier cloud fallback (replaces hardcoded curated lists)

## Status

Accepted (2026-09-02).

## Context

The content-classifier's cloud fallback (when Ollama is down) needs a list of
cheap, capable-enough cloud models to send the classification prompt to. Two
prior approaches both failed in production:

1. **Hardcoded `free_models` in `router-config.json`** — only listed
   `openrouter/*:free` models. A user with a Mistral/Anthropic key but no
   OpenRouter key got an empty candidate list.
2. **Hardcoded `CURATED_FREE_MODELS` (commit `ab625af`)** — a hand-maintained
   array of `['mistral-zai/mistral-small-latest', 'mistral/mistral-small-latest',
   ...]` prepended to `getCheapestCloudModels()`. This worked for exactly one
   user's provider setup (the user who wrote it); every other user got
   nothing from it. It was also a maintenance smell: the list had to be
   manually kept in sync with which models Mistral actually serves.

The user's explicit request (2026-09-02): "analyze all registered models from
pi's scan, select 'low-level but not too low-level' models, probe them for
availability, cache the working ones until the next `/router scan`, and use
them as cloud fallback."

## Decision Drivers

- **No hardcoded model names.** A list that only works for the user who wrote
  it is a regression waiting to happen for everyone else. The discovery must
  work out-of-the-box for any combination of configured providers.
- **gdpval is sparse.** Only ~27/121 models in a typical scan have gdpval
  scores (most cloud models are unscored). A strict "cheap AND low-gdpval"
  filter yields zero candidates for most users — the tiering must degrade
  gracefully when gdpval is unknown.
- **`cost_per_m === 0` is not a "free" signal.** For generic direct-API
  providers (mistral, mistral-zai, anthropic — matched via `modelsUrl`+
  `authHeader` in `PROVIDER_MAP`), `cost_per_m` is hardcoded to 0 because the
  scan never fetches real per-token pricing for them. So `$0` there means
  "we never checked", not "this is free". See ADR 0004 finding F3.
- **Broken models waste classification time.** `mistral-zai/mistral-small-latest`
  returns 422 on every call (the z.ai endpoint doesn't serve native Mistral
  models). OpenRouter `:free` models fail 429 once the 50/day daily limit is
  hit, and 404 when the workspace guardrails block them. Probing once per
  scan cycle filters these out — re-trying them per classification would add
  ~300ms-1s of wasted latency per broken candidate.
- **Probe at scan time, not classification time.** The user explicitly chose
  scan-time probing: it runs once per `/router scan` (a user-triggered,
  non-latency-sensitive operation) instead of once per classification (a
  latency-sensitive path). The cached result is reused until the next scan.

## Options Considered

### A — Keep the hardcoded curated list, just expand it (rejected)

Add more known-free/cheap models to `CURATED_FREE_MODELS` (e.g. anthropic
haiku variants, openrouter minimax, etc.).

- **Pros:** Smallest diff; no new module.
- **Cons — this is why it's rejected:** Still only works for users whose
  providers match the list. Still requires manual maintenance. Still
  re-tries broken models (422/429/404) on every classification because there's
  no probe step. This is the exact smell the user asked to remove.

### B — Probe at classification time (lazy probe, rejected)

On each classification, pick candidates via `selectClassifierCandidates()`
and try them one-by-one until one works (the existing try-each loop).

- **Pros:** No scan-time step; always uses the freshest availability data.
- **Cons — why this is rejected:** Adds ~300ms-1s per broken candidate to
  every classification when Ollama is down (the exact case the fallback fires
  in). The user explicitly chose scan-time probing to avoid this per-call
  latency. Also, a transient network blip during classification would
  permanently exclude a working model for that turn, with no recovery until
  the next scan.

### C — Probe at scan time, cache the working list (accepted)

At the end of `scan()` (after `saveCache()`, before `generateDynamicConfig`),
run `probeAndCache()`: it calls `selectClassifierCandidates()` to pick
candidates, sends a tiny "Reply with OK" request to each via pi's
`completeSimple`, and caches the refs that respond in
`cache.classifier_fallback_models`. The classifier reads that cached list at
fallback time — no probing per classification.

Selection is tiered to handle gdpval sparsity:
- **Tier A** (best): real per-token price ≤ $5/M AND known gdpval ≤ 700.
- **Tier B**: real price ≤ $5/M, gdpval unknown (most cloud models).
- **Tier C**: placeholder `$0` (provider-level `cost_per_m:0`, no real pricing
  — e.g. mistral-zai). The probe decides if they actually work.

Candidates are assembled with **round-robin provider interleaving** (not
strict Tier A→B→C order) so a single down/rate-limited provider cannot
monopolize the candidate list. This was a production bug: OpenRouter's
free-tier daily limit was exhausted (429 on all `:free` models) and the 12
Tier-B OpenRouter candidates filled every slot, so Tier-C Mistral models
(with a working key) were never probed → 0 working models cached.

The probe is bounded: max 20 candidates, 15s timeout each, stops at 8
successes. Unhealthy models (failed ≥2× recently, per `model_health`) are
excluded; health decays after 15 min so recovered models get re-probed next
scan.

- **Pros:** Works for any provider combination. Filters broken models once
  per scan, not per classification. No hardcoded model names. The cached list
  survives until the next `/router scan`.
- **Cons:** Adds ~1-4s to each `/router scan` (observed: 20 candidates, most
  fail fast in <500ms; the 15s timeout only kicks in for hanging connections).
  The cached list can go stale within a scan cycle if a model starts failing
  after the probe — but the classifier's try-each loop handles this (a
  cached model that fails at classification time is just skipped, and the
  next one is tried).

## Decision

**Option C.** `src/classifier-fallback-probe.ts` exports
`selectClassifierCandidates()`, `probeAndCache()`, `getCachedFallbackModels()`,
and `hasProbedFallback()`. The probe is wired into `scan()` in `index.ts`
after `saveCache()`, using `sessionCtx.modelRegistry` for `findModel`/
`completeSimple`. The classifier in `src/content-classifier.ts` prefers the
cached list, falling back to `selectClassifierCandidates()` + the existing
try-each loop if the probe hasn't run yet.

The hardcoded `CURATED_FREE_MODELS` constant is removed from `src/discovery.ts`.
`getCheapestCloudModels()` is kept for backward compatibility (its tests
still cover the pricing-lookup logic) but the classifier no longer relies on
it as the primary path.

## Consequences

- The cloud fallback now works for any user's provider setup, not just one.
- Broken models (422/429/404) are filtered once per scan cycle, not retried
  per classification.
- The `/router scan` step takes ~1-4s longer (the probe). This is
  non-latency-sensitive (user-triggered) and the trade-off is explicitly
  accepted.
- A new cache field `classifier_fallback_models?: string[]` is added to the
  `Cache` type. Empty array = probe ran but all failed; absent = probe hasn't
  run yet this scan cycle.
- The classifier's failure path is now: cached probe list →
  `selectClassifierCandidates` (lazy discovery) → static `free_models` from
  config → static keyword classification. Three dynamic layers before the
  static fallback.
- Regression tests: `test/classifier-fallback-probe.test.ts` (15 tests:
  tiering, gdpval-sparsity degradation, unhealthy exclusion, probe
  success/failure/skip/throw, early-stop, provider round-robin
  interleaving, cache readback).
