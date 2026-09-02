# 0004 — Use pi's `modelRegistry` for cloud classification fallback

## Status

Accepted (2026-09-02).

## Context

The content-classifier's cloud fallback (the last resort before static
keyword classification, when both Ollama models are down) needs to call a
cloud model to classify the user's prompt. The original implementation
(`src/cloud-client.ts`, commit `31e2419`) rolled its own HTTP client:

- `CloudClient.callModel()` built a raw `fetch()` to the provider's
  `/chat/completions` endpoint.
- It resolved the API key by reading `cfg.providers[provider].keys[0].key`
  from `router-config.json`.

This had two compounding defects observed in production (2026-09-02):

1. **The key was in the wrong place.** The user's OpenRouter key lives in
   pi's own auth store (`~/.pi/agent/auth.json`), not in
   `router-config.json`. So `CloudClient` always failed with
   `"No API key for provider: openrouter"` — the cloud fallback was dead
   code in practice, never succeeding once.
2. **The router was duplicating pi's job.** Pi already knows how to
   authenticate every provider it registers (that's what
   `modelRegistry.find()` + pi's runtime stream/complete path do every
   turn). Rolling a second HTTP client meant a second auth-resolution path,
   a second place to handle rate-limit headers, a second place to learn
   context windows from overflow errors, etc. — every one of which would
   drift from pi's own behavior over time.

The user's explicit instruction going into the fix: "I want pi's internals
used everywhere — no router-rolled dependencies. Pi knows the models." The
chosen approach was labeled "Pragmatic: pi for cloud only" — use pi's
`modelRegistry.completeSimple()` + `registry.find()` for the cloud
classification path, nothing custom.

## Decision Drivers

- **Single source of truth for auth.** Pi's `modelRegistry` is the only
  thing that should know how to reach a provider. A second HTTP client
  reading a second config key path will silently disagree with pi (as it
  already did: `auth.json` vs `router-config.json`).
- **Data minimization.** The cloud fallback carries raw user prompt text
  (unlike the GDPval model-slug matcher, which only sends model IDs). It
  must remain opt-in (`classifier_cloud_fallback: true`, off by default)
  and must use the same provider/auth the user already trust for normal
  answering — not a parallel path that could accidentally leak to a
  differently-configured key.
- **Fast Ollama path preserved.** The Ollama-first classifier path is
  unchanged when Ollama IS running; the cloud path only fires as a fallback.
- **`registerProvider` replaces, not merges** (see ADR 0005) — so the
  fallback must not register a provider pi doesn't already know in a way
  that would clobber pi's existing entries.

## Options Considered

### A — Keep a custom HTTP client, just fix the key path (rejected)

Add a `getApiKeyForProvider` option to `CloudClientOptions` that reads from
pi's `auth.json` instead of `router-config.json`. Minimal change, keeps
the existing `callModel` interface.

- **Pros:** Smallest diff; no new dependency on pi's internal runtime API.
- **Cons — this is why it's rejected:** Still duplicates pi's auth +
  rate-limit + overflow handling in a second code path. The user explicitly
  rejected this ("no router-rolled dependencies"). It would fix today's
  symptom (wrong key path) while leaving the architectural drift in place
  for the next divergence.

### B — Use pi's `modelRegistry.completeSimple()` + `registry.find()` (accepted)

Replace `CloudClient.callModel` with
`registry.runtime.completeSimple({ messages }, modelRef)` (matching the
existing `hostStreamSimple` pattern) and use `registry.find()` to verify
the model is registered before calling. `CloudClient` and its test are
deleted entirely.

- **Pros:** Single source of truth for auth, rate-limit handling, and
  context-window learning — pi's. No second HTTP client to drift. The
  fallback uses the exact same provider/auth path every other request
  uses. `getCheapestCloudModels()` (in `src/discovery.ts`) dynamically
  discovers the cheapest cloud models, so the fallback isn't hard-coded
  to a specific model.
- **Cons:** Couples the classifier to pi's internal runtime API
  (`registry.runtime.completeSimple`), which is less stable than a raw
  HTTP call. Mitigation: the reach-through matches the existing
  `hostStreamSimple` pattern already used elsewhere, so it's a known
  shape, not a new one.

### C — Use pi's full stream path (`tryStream`) (rejected)

Route the cloud classification through pi's full `tryStream`/`driveStream`
cascade, which would get rate-limit handling and fallback for free.

- **Pros:** Most "pi-native" — the classifier becomes just another stream.
- **Cons — why this is rejected:** `driveStream` is designed for answering
  (long output, cascade across many candidates, user-facing error
  messages). Classification is a short, single-shot call that needs a
  parsed JSON result, not a streamed prose answer. Running it through
  `driveStream` would conflate two different concerns and make the
  classifier's failure modes (bad JSON, empty response) look like
  answering failures. `completeSimple` is the right abstraction: one call,
  one result, pi's auth.

## Decision

**Option B.** The classifier's cloud fallback uses pi's
`modelRegistry.completeSimple()` + `registry.find()`. `src/cloud-client.ts`
and `test/cloud-client.test.ts` are deleted. The fallback is gated by
`if (allowCloudFallback && cfg && cache && completeSimple && findModel)` —
all four must be present. On overflow errors, the fallback learns the
model's real context window and drops it from the retry list (recursion
guard via `ctx.recordSoftFailure` before recursing).

## Consequences

- `src/cloud-client.ts` and `test/cloud-client.test.ts` deleted (net
  -264 lines across the change).
- The cloud fallback now authenticates through pi — no separate key path.
- `getCheapestCloudModels()` in `src/discovery.ts` dynamically discovers
  candidates; known limitation (finding F3): subscription models with no
  OpenRouter pricing data are invisible to it (documented inline).
- The classifier is now coupled to `registry.runtime.completeSimple`,
  matching the existing `hostStreamSimple` reach-through pattern.
- Regression tests: `test/overflow-try-larger.test.ts` (2 integration
  tests), `test/classifier-cloud-fallback-opt-in.test.ts`.
