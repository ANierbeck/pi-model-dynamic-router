# Architecture Review — Cloud-Based Classification Fallback & Routing Escalation

**Date:** 2026-09-02
**Scope:** Commits `a4d618f`, `178b1ff`, `3468a43` (the "cloud fallback via pi's modelRegistry" refactor + overflow-error learning + roborev follow-ups)
**Trigger:** The user observed that a task that should have escalated to a GLM-5.2 / Sonnet-class model was instead served by `openrouter/minimax/minimax-m2.7:free` (a free mini model). This review finds out why, documents the architecture as actually implemented, and flags every defect — **no implementation, documentation only** as requested.

---

## TL;DR (the answer to "why did it stick to a mini model?")

The classifier **failed completely** for every production turn on 2026-09-02 after ~05:40:

1. **Ollama was down** (`fetch failed` on the primary `gemma4:12b-mlx` and fallback `gemma2:2b`).
2. The **cloud fallback** (the new `completeSimple` path) tried 5 free OpenRouter models. **All 5 failed**: 2× HTTP 429 (free-tier daily rate limit exhausted), 2× HTTP 404 (OpenRouter guardrail/data-policy rejection), 1× HTTP 403 (`inkling-small:free` is agentic-harness-only).
3. The classifier fell through to its hard-coded last resort: `{ category: 'fallback', confidence: 0 }`.
4. `fallback` maps to the `tactical` group (`min_gdpval: 600`). But `tactical` found **zero candidates that pi's registry actually had with a gdpval ≥ 600** — see Finding F4 for why the scored GLM-5.2 was invisible — so `resolve()` cascaded through `fallback_groups` `[operational, scout, fallback]` all the way to the `fallback` group (`min_gdpval: 0`, no gate).
5. The `fallback` group sorted by `method: 'tiered'` (billing preference) and picked the cheapest registered model with a gdpval: `openrouter/minimax/minimax-m2.7:free` (gdpval 1157, free tier).

**Net:** the architecture *is* capable of triggering GLM-5.2 / Sonnet — but three independent defects stack to make it fail in practice:

- **F1** (template-literal bug): 7 log lines in `content-classifier.ts` use single quotes where backticks were intended, so `${modelRef}` etc. print literally. A "cheap model" code smell and it makes the cloud-fallback logs untriageable.
- **F3** (cloud fallback only sees free OpenRouter models): `getCheapestCloudModels()` filters by `lookupPrice(ref)` and requires `price.output <= $5/M`. Subscription models (`mistral-zai/*`, including the user's free-to-them GLM-5.2) have **no pricing data** in the OpenRouter pricing cache → `lookupPrice` returns `null` → they are filtered out. The classifier's cloud fallback therefore **never tries mistral-zai/glm-5-2**, only free OpenRouter models — which are all rate-limited right now.
- **F4** (the scored GLM-5.2 variant is invisible to routing): pi's `models.json` registers `mistral-zai` with exactly one model, `zai-glm-5-2`, carrying user-curated compat flags. The Ü1 guard in `registerGroupModels` (correctly) refuses to overwrite a provider pi already knows — but as a side effect it **never registers the other 45 scan-discovered mistral-zai models**, including `mistral-zai/glm-5-2` (the variant whose slug `glm-5-2` has gdpval 1497.55). The registered `zai-glm-5-2` has slug `zai-glm-5-2` which is **unscored** → fails `tactical`'s `min_gdpval: 600` → never a candidate. So even when the classifier returns `fallback→tactical`, tactical cannot pick GLM-5.2.

A secondary, user-side trigger is documented in F6: the user's `HINT use mistral-zai/glm-5-2` (without a colon) was not recognized by `detectHintDirectly`, which requires `HINT:`.

### Update after the user's follow-up ("it still goes for the minimax-m2.7 free model")

The user restarted pi at 09:48 and re-asked. Ollama came back, so the classifier worked (`code_complex → tactical` at 09:50:24). But `tactical` **still** picked `openrouter/liquid/lfm-2.5-2.6b:free` instead of `pi-claude/claude-sonnet-5` (gdpval 1603) or `mistral-zai/glm-5-2` (gdpval 1497). The reason is a **new, live defect — F10**:

A parallel subagent fanout at 09:50:23 overwhelmed Ollama (crash) and triggered a retry storm across every cloud model. `pi-claude/claude-sonnet-5` returned `provider_error` (the stream was aborted by the cascade), and `isPaidCloudRateLimitFailure` classified that bare `provider_error` as a rate limit → **2-hour cooldown ending 11:51**. So at the main turn, Sonnet was in `isLimited` cooldown and filtered out of `tactical`. With the scored GLM-5.2 also invisible (F4), `tactical` had no high-gdpval candidate → cascaded to `fallback` → `lfm-2.5-2.6b:free`.

**The first review's claim that "Sonnet is unreachable because the user has no pi-claude key" was WRONG.** `pi-claude/claude-sonnet-5` resolves successfully via `tryStream` (`api=claude-bridge`) and is in pi's registry — pi registers and authenticates it itself. The router does not need a key for it. This is the architectural principle the refactor established (F11): **pi knows the models and gives the router the information; the router must use that, not require duplicated keys.** The first review applied the old `CloudClient` mental model to a provider that pi owns.

---

## 1. How the architecture actually works (as implemented)

### 1.1 The classification → routing pipeline

```
user prompt
   │
   ▼
before_user_prompt hook (stream-orchestrator.ts, dynamic group path)
   │
   ▼
classifyPrompt()  ── content-classifier.ts
   │  1. detectHintDirectly()  → deterministic HINT: parsing (no LLM)
   │  2. isCompaction?         → reuse last model or route to strategic
   │  3. short-prompt momentum?→ inherit last category
   │  4. cache hit?            → return cached LLM result
   │  5. Ollama primary (gemma4:12b-mlx) → LLM classify
   │  6. Ollama fallback (gemma2:2b)      → LLM classify
   │  7. applyEscalationLogic() on the LLM result (if lastModel known)
   │  8. cloud fallback (NEW): pi completeSimple on getCheapestCloudModels()
   │  9. static keyword classifier (if allowStaticFallback)
   │ 10. hard-coded { category:'fallback', confidence:0 }
   ▼
FullClassificationResult  (category OR hintType/hintTarget)
   │
   ▼  CATEGORY_TO_GROUP maps category → group name
   │     trivial→scout, simple→operational, code_simple→simple,
   │     standard→operational, code_complex→tactical, design→tactical,
   │     planning→tactical, exploration→scout, fallback→tactical
   ▼
resolve(groupName)  ── routing.ts
   │  resolveGroup() applies: exclude → min_gdpval → budget → dedup → sort(method)
   │  if empty → cascade fallback_groups → … → null
   ▼
driveStream(candidates, …)  ── stream-orchestrator.ts
   │  for each candidate: tryStream → hostStreamSimple
   │  on rate-limit/provider-error → recordSoftFailure, try next
   │  on context_overflow → extractContextWindowFromError, try larger
   ▼
pi streams the selected model
```

### 1.2 The cloud fallback (the new path, commits a4d618f + 178b1ff)

When Ollama is unavailable, `classifyPrompt()` enters the cloud-fallback block (`content-classifier.ts:~520`) if **all four** of `allowCloudFallback && cfg && cache && completeSimple && findModel` are present (the data-minimization opt-in gate is preserved — `allowCloudFallback` alone is insufficient).

Flow:
1. `new DiscoveryManager(cfg, cache).getCheapestCloudModels()` — returns up to 5 refs sorted by output price ascending (see F3 for the filter).
2. If that is empty, fall back to `discovery.getFreeModels()` — the hardcoded `free_models` lists from `router-config.json` providers.
3. For each ref: `findModel(ref)` resolves it to a pi `Model`; `completeSimple(model, classifyCtx, undefined)` runs the one-shot call. `completeSimple` is reached through `registry.runtime.completeSimple` (the private `ModelRuntime`, not the public facade — roborev HIGH-1 fix, `stream-orchestrator.ts:229-236`).
4. Parse `AssistantMessage.content` (array of `TextContent | ThinkingContent | ToolCall`), concatenate `text` blocks, strip `<think>`, extract JSON, validate.
5. On success: optionally apply escalation, return. On per-model error: log and `continue`. On total failure: fall through to static/hard-coded fallback.

The `classifyCtx` passed to `completeSimple` is `{ messages: [{ role: 'user', content: ollamaPrompt }] }` — a minimal `Context`.

### 1.3 The overflow-error learning (commit a4d618f + roborev follow-up 178b1ff)

When `driveStream` gets a `context_overflow` result from a provider:
1. `extractContextWindowFromError(result.detail)` parses the real context window + requested-token count from OpenRouter-style error text (`maximum context length is N tokens. However, you requested about M tokens`).
2. If parseable: `ctx.updateModelContextWindow(ref, actualContextWindow)` writes the discovered window into pi's registry (sticky), so future pre-flight guard skips this model for oversized prompts.
3. Filter remaining candidates to those with a context window > minNeeded, recurse into them ("try larger before compaction").
4. **Roborev HIGH-2 fix (`178b1ff`)**: `ctx.recordSoftFailure(ref)` is called before recursing, and the overflowing model is dropped from the `tried` list. This guards against unbounded recursion when the error text is unparseable (`errInfo === null`): without `recordSoftFailure`, cooldown wouldn't exclude the model, and since the registry update was skipped, the pre-flight guard wouldn't either — the model would be retried, overflow the same way, and recurse until stack overflow.

### 1.4 Where models come from (the three sources)

`allDiscoveredRefs()` in `routing.ts` (the candidate pool for every group) merges:
1. **pi's model registry** — `sessionCtx.modelRegistry.getAvailable()` — the **primary, authoritative source**. Populated by `registerGroupModels` at `session_start` and `registerFreeModelOnDemand` on first reference.
2. **`cache.available_models`** — the scan cache (`dist/.cache/scan-cache.json` in production). Used only as a fallback when `sessionCtx` is absent.
3. **`cfg.providers.*.free_models`** — the hardcoded free-model lists in `router-config.json`.

The scan cache (`dist/.cache/scan-cache.json`) also holds: `gdpval_scores` (quality scores), `openrouter_pricing` (price lookups), `model_health` (failure streaks), `budget_cache`. These feed `lookupGdp`, `lookupPrice`, `demoteUnhealthy`, `filterByBudget`.

### 1.5 Provider registration at session start (`registerGroupModels`, index.ts:2390)

For each provider in `PROVIDER_MAP` with a resolvable key (from `cfg.providers[].keys` **or** from pi's auth store via `def.authKey`):
- Collect that provider's models from `cache.available_models`.
- **Ü1 guard**: if pi's registry already knows **any** of that provider's models (typically from `~/.pi/agent/models.json`), **skip registration entirely** — never overwrite a user-curated entry (this protects compat flags like `supportsStore`, `maxTokensField`).
- Otherwise register the provider with all scan-discovered models + real per-model capabilities.

`registerFreeModelOnDemand` (index.ts:1686) is the lazy path: when a free model ref is first referenced and its provider isn't registered, register just the `free_models` list. It respects the same Ü1 guard.

---

## 2. Findings

### F1 — Template-literal-as-plain-string bugs (HIGH, "cheap model" smell)

**Status: RESOLVED (2026-09-02, commit `0454d2b`).** 10 template-literal bugs in `src/content-classifier.ts` fixed (backticks added so `${...}` interpolates instead of being sent as literal text to the classifier LLM).

**Location:** `src/content-classifier.ts` lines 411, 424, 436, 542, 547, 560, 571
**Evidence:** 7 `routerLog` calls use single-quoted strings where backticks were intended:
```ts
routerLog('[classifier] Cloud model ${modelRef} failed', ...);   // literal "${modelRef}"
routerLog('[classifier] Primary model "${model}" failed, ...');  // literal "${model}"
```
**Impact:** The classifier cloud-fallback logs print `${modelRef}` literally, so you cannot tell from the log *which* model failed. This is exactly the "cheap model" code-quality concern the user raised, and it made the production log triage for this review harder than it should have been.
**Fix direction:** Convert the 7 lines to backtick template literals.

### F2 — The repo-root `.cache/scan-cache.json` is empty; only `dist/.cache/scan-cache.json` is populated

**Status: RESOLVED (2026-09-02, commit `fd2e68e`).** Resolved by the F8 fix (isScanCacheValid rejects a fresh-but-empty cache, forcing a rescan) + deleting the stale empty `.cache/scan-cache.json`.

**Evidence:**
- `.cache/scan-cache.json`: `available_models: 0`, `gdpval_scores: 0`, `openrouter_pricing: 0`, `lastScanTimestamp: 2026-09-01T15:10:41Z`.
- `dist/.cache/scan-cache.json`: `available_models: 120`, `gdpval_scores: 349`, `openrouter_pricing: 872`, `lastScanTimestamp: 2026-08-16T10:50:40Z`.
**Impact:** The production router (running from `dist/`) uses the populated cache. The dev/test path (running from TS source via `import('../index.ts')`) reads `repoRoot/router-config.json` as `extDir` and `repoRoot/.cache/scan-cache.json` — which is empty. This is a **test/dev hygiene issue**, not a production bug, but it means any test that doesn't mock the cache is running against zero models/scores/prices. It also caused confusion during this review until the two caches were distinguished.
**Note:** The freshness gate ("Scan cache is still valid (max 30 days old), skipping regeneration") passes for both, so neither triggers a rescan. The dist cache is 17 days old (Aug 16 → Sep 2) — still "valid" but stale enough that newly added models (e.g. glm-5.3) are missing.

### F3 — Cloud fallback only ever tries free OpenRouter models; subscription GLM-5.2 is invisible (HIGH — core of the user's complaint)

**Status: RESOLVED (2026-09-02).** The probe-based discovery
(`src/classifier-fallback-probe.ts`, ADR 0006) replaces `getCheapestCloudModels`
as the classifier's primary path. `selectClassifierCandidates()` includes
Tier C (placeholder-$0 providers like mistral-zai), and `probeAndCache()`
actually probes them — so the fallback now reaches working Mistral models
instead of only OpenRouter free models. Round-robin provider interleaving
prevents OpenRouter from monopolizing the candidate list.

**Location:** `src/discovery.ts` `getCheapestCloudModels()` lines 415-425
**Root cause:** The filter is:
```ts
const price = lookupPrice(ref);
if (!price) continue;            // (a) skip if no pricing data
if (price.output === 'unknown') continue;
if (price.output <= maxPricePerM) priced.push({ ref, output: price.output });
```
`lookupPrice(ref)` (`src/metrics.ts:491`) resolves price from: `cfg.model_metrics[ref]` → `cache.openrouter_pricing[ref]` → backfill by normalized model id → `cfg.providers[provider].cost_per_m` → `null`.

For `mistral-zai/*` models:
- Not in `cfg.model_metrics` (only 5 entries).
- Not in `cache.openrouter_pricing` (that cache only has `openrouter/...` and bare `z-ai/...` keys — no `mistral-zai/...` keys).
- Backfill normalizes model id (`zai-glm-5-2` → no match against `glm-5.2`).
- `cfg.providers['mistral-zai']` is `undefined` (the config only declares `openrouter`).
→ `lookupPrice` returns `null` → **all 46 mistral-zai subscription models (including the user's free-to-them GLM-5.2) are filtered out**.

**Result:** `getCheapestCloudModels()` returns 5 refs, all with `output: $0` (free OpenRouter tier): `lfm-2.5-2.6b:free`, `north-mini-code:free`, `glm-5.2:free`, `gemma-4-26b:free`, `gemma-4-31b:free`. The classifier's cloud fallback **never tries mistral-zai/glm-5-2**, even though it is free to the user, in pi's registry, and high quality.

On 2026-09-02 all 5 free OpenRouter models failed (429 daily rate-limit exhausted + 404 guardrails + 403 agentic-only), so the cloud fallback produced no classification and the router fell through to the hard-coded `fallback` category.

**Fix direction:** `getCheapestCloudModels` should treat subscription models with `cost_per_m === 0` (discovered in `available_models`) as price `$0`, not as "unknown / skip". The candidate-collection step already sees them; the price-filter step rejects them. Either (a) use `getM(ref).cost_per_m` (which correctly returns `0` for discovered subscription models) instead of `lookupPrice`, or (b) add a "subscription = $0" branch before the `!price` skip.

### F4 — The scored GLM-5.2 variant is invisible to group routing (HIGH)

**Status: RESOLVED (2026-09-02, commit `0454d2b` + `bfb2e16`).** The Ü1 guard now checks models individually; in the mixed case it round-trips pi's known Model objects (preserving compat flags) and passes the UNION to `registerProvider` (ADR 0005). Scored scan-discovered variants (e.g. `mistral-zai/glm-5-2`, gdpval 1497) are now registered alongside the unscored `zai-glm-5-2`.

**Location:** `index.ts:2390` `registerGroupModels` Ü1 guard; `~/.pi/agent/models.json`
**Evidence:**
- pi's `models.json` registers `mistral-zai` with exactly **one** model: `zai-glm-5-2` (with user-curated compat flags — `supportsStore`, `maxTokensField` — that the Ü1 guard correctly protects from overwrite).
- The scan cache (`dist/.cache/scan-cache.json`) discovered 46 mistral-zai models, including `mistral-zai/glm-5-2` (slug `glm-5-2`, gdpval **1497.55**) and `mistral-zai/zai-glm-5-2` (slug `zai-glm-5-2`, **unscored**).
- At session start, `registerGroupModels` sees pi already knows `mistral-zai/zai-glm-5-2` → **skips the whole provider** → `mistral-zai/glm-5-2` (the scored variant) is **never registered** → not in `modelRegistry.getAvailable()` → not in `allDiscoveredRefs()` → not a candidate for any group.
- The registered `mistral-zai/zai-glm-5-2` has slug `zai-glm-5-2`, which has **no gdpval score** → `lookupGdp` returns `null` → fails `tactical`'s `min_gdpval: 600` filter → never a tactical candidate.
**Result:** When the classifier returns `fallback → tactical`, `resolve('tactical')` finds no GLM-5.2 it can use (the scored variant isn't registered; the registered variant is unscored). It cascades through `fallback_groups` to the `fallback` group and picks `openrouter/minimax/minimax-m2.7:free`.
**Confirmation:** The HINT fallback candidates log at 09:15 (`[dynamic] HINT fallback candidates: …`) lists `mistral-zai/zai-glm-5-2` but **not** `mistral-zai/glm-5-2` — proving the registry has only the unscored variant.
**Fix direction:** The Ü1 guard is correct (don't overwrite models.json). The fix is to make `lookupGdp` resolve `zai-glm-5-2` to the `glm-5-2` score (they are the same model — `zai-` is a provider-specific prefix), **or** register the additional scan-discovered models without overwriting the models.json entry's compat flags (a "merge, don't replace" registration). The slug-matcher's token-set fallback should already try this; it isn't matching, which is a separate slug-resolution gap.

### F5 — Escalation logic is skipped when the classifier fails entirely (MEDIUM)

**Status: RESOLVED (2026-09-02, commit `fd2e68e`).** `applyEscalationLogic` now runs on the hard-coded `{ category: 'fallback' }` return path too (the `allowStaticFallback=false` branch), so the last model's tier still triggers a bump when the task complexity warrants it.

**Location:** `src/content-classifier.ts:~498-505` and the final `return { category:'fallback' }` at ~580.
**Root cause:** `applyEscalationLogic` runs only on a *successful* `classificationResult` (`if (classificationResult && context.lastModel …)`). When Ollama fails AND the cloud fallback fails, the code reaches the end and returns the hard-coded `{ category:'fallback', confidence:0 }` **without** applying escalation. So a user on a cheap model who asks a complex question while Ollama is down gets `fallback→tactical`, but tactical's *intent* (escalate to a capable model) is never enforced — and per F4, tactical can't find GLM-5.2 anyway.
**Impact:** Compounds F3+F4: even the "bump to a bigger model" safety net is disabled in the exact failure mode the user hit.
**Fix direction:** Apply `applyEscalationLogic` to the hard-coded fallback result too, or — better — make the fallback category itself reflect the last model's tier.

### F6 — `HINT` without a colon is not recognized (MEDIUM, usability)

**Status: RESOLVED (2026-09-02, commit `fd2e68e`).** `detectHintDirectly`'s regex now accepts an optional colon. False-positive guard: require either a colon OR a group-verb (use/nutze/verwende/benutze) after HINT, so the word "hint" in natural prose does not match.

**Location:** `src/content-classifier.ts` `detectHintDirectly`, regex `/^\s*HINT\s*:\s*(.+)/i`
**Evidence:** At 06:27 the user sent `"HINT use mistral-zai/glm-5-2 Please proceed…"` (no colon). The regex requires `HINT:` → no match → `detectHintDirectly` returns null → the prompt went through the (failing) LLM classifier → routed to `minimax-m2.7:free`. The user's intent was ignored.
**Fix direction:** Make the colon optional (`/^\s*HINT\s*:?\s*(.+)/i`), but guard against false positives (the word "hint" in natural prose). Alternatively, accept `HINT` as a standalone token followed by whitespace.

### F7 — `getCheapestCloudModels` returns only $0 models, never cheap paid or subscription (MEDIUM, design)

**Status: RESOLVED (moot, 2026-09-02, commit `fd2e68e`).** `getCheapestCloudModels` was dead code (no production callers) and is deleted. The classifier's cloud fallback now uses the probe-based discovery (ADR 0006), which tiers by price + gdpval and actually probes Tier C (placeholder-$0) providers — so the quality-floor problem is solved at the discovery layer, not by patching a dead function.

**Location:** `src/discovery.ts:415-425`
**Root cause:** Even if F3 were fixed (subscription models priced at $0), the sort-by-price-ascending + `maxResults=5` means the 5 cheapest are **always all $0 free-tier OpenRouter models**. A cheap paid model (e.g. `glm-5.3-flash` at $0.25/M output) or a subscription GLM-5.2 would never be reached because the $0 free tier fills the top-5 first.
**Impact:** The cloud fallback has no quality floor — it will always pick the absolute cheapest models, which on OpenRouter means the free tier, which is the most rate-limited and guardrail-restricted tier. The classifier — a quality-sensitive task (it decides the model for the whole turn) — is being routed to the lowest-quality, least-reliable models.
**Fix direction:** Add a quality floor to the cloud fallback (e.g. `min_gdpval` on the fallback candidates), or include subscription models with a gdpval ≥ some threshold ahead of unscored free-tier models.

### F8 — Stale/empty scan cache is considered "valid" and never rescanned (MEDIUM, hygiene)

**Status: RESOLVED (2026-09-02, commit `fd2e68e`).** `isScanCacheValid()` now rejects a fresh-but-EMPTY cache (0 available_models) and forces a rescan. The test helper `writeNoOpScanCache` writes a single placeholder model so the no-op cache still passes the sanity check.

**Location:** scan-cache freshness gate ("Scan cache is still valid (max 30 days old), skipping regeneration").
**Evidence:** The dist cache is from 2026-08-16 (17 days old). The repo-root cache is from 2026-09-01 but is **completely empty** (0 models, 0 scores, 0 prices). Both pass the 30-day freshness check, so neither triggers a rescan. New models added since the last scan (e.g. glm-5.3) are absent; pricing changes are stale.
**Impact:** Compounds F3 (no mistral-zai pricing) and F4 (slug-resolution relies on a stale gdpval map).
**Fix direction:** Tighten the freshness window, or add a "cache is empty but timestamp is fresh" sanity check that forces a rescan.

### F9 — OpenRouter free-tier daily rate limit is a single point of failure for the whole router (MEDIUM, operational)

**Status: RESOLVED (2026-09-02).** With the probe-based discovery (ADR 0006),
the fallback no longer depends solely on OpenRouter free models. The probe
reaches Tier C Mistral models (with a working key) via round-robin
interleaving, so exhausting the OpenRouter daily quota no longer disables
the entire cloud classification fallback. Verified in production logs:
`mistral/mistral-small-2603` and `mistral/mistral-large-2512` were probed
OK and cached while every OpenRouter `:free` model failed 429/404.

**Evidence (historical):** At 09:14 and 09:26, two cloud models returned HTTP 429 with `X-RateLimit-Remaining: 0` and `X-RateLimit-Reset: 1788393600000` (a daily reset). The user's OpenRouter free tier (50 requests/day) was exhausted. Because F3+F7 mean the cloud fallback only ever tries free OpenRouter models, **exhausting the OpenRouter daily free-tier quota disables the entire cloud classification fallback**.
**Impact (historical):** This is the immediate trigger for the user's observed failure. The router has a perfectly good mistral-zai subscription (free to the user, high quality) that it cannot reach in the fallback path.
**Fix direction:** Fixing F3 (include subscription models) resolves this — the fallback would use mistral-zai/glm-5-2 instead of the rate-limited OpenRouter free tier.

### F10 — pi-claude (Sonnet) gets a false-positive 2-hour rate-limit cooldown from cascade-induced aborts (HIGH — the live bug behind "still goes for minimax")

**Status: RESOLVED (2026-09-02, commit `0454d2b`).** `provider_error` removed from `isRateLimitLikeReason`; added `isAbortLikeText()` so abort/timeout text is treated as an abort (no hard cooldown), not a paid-cloud rate limit. F11 (below) also unblocks pi-claude by making the router recognize pi-registered providers.

**Location:** `src/detection.ts:333` `isPaidCloudRateLimitFailure`; `src/stream-orchestrator.ts:601-612`.
**Evidence (production log, 2026-09-02T09:50:23.932-933):**
```
[router] mistral-zai/zai-glm-5-2 — provider error: This operation was aborted (likely rate limit) (resets 2.9.2026, 11:51:23), trying pi-claude/claude-sonnet-5 …
[router] pi-claude/claude-sonnet-5 — provider error: This operation was aborted (likely rate limit) (resets 2.9.2026, 11:51:23), trying pi-claude/claude-sonnet-4-6 …
[router] pi-claude/claude-sonnet-4-6 — provider error: This operation was aborted (likely rate limit) (resets 2.9.2026, 11:51:23), trying mistral/devstral-small-2505 …
```
This was a **parallel subagent fanout** that overwhelmed Ollama (crash) and then triggered a retry storm across every cloud model. `pi-claude/claude-sonnet-5` returned `provider_error` — almost certainly because the stream was **aborted by the cascade** (Ollama crashed, the fanout errored), NOT because pi-claude actually rate-limited.
**Root cause:** `isPaidCloudRateLimitFailure('pi-claude/claude-sonnet-5', 'provider_error')` returns **true** because:
- `isCloudProvider`: `pi-claude/...` doesn't start with `ollama/` or `lm-studio/` → true.
- `isFreeModel`: no `:free` tag → `!isFreeModel` = true.
- `isRateLimitLikeReason('provider_error')` → true (it's in the list: `empty_response | empty_timeout | stall_timeout | provider_error`).
→ `recordStreamFailure` applies the **default 2-hour cooldown** (reset at 11:51). pi-claude is then filtered out by `isLimited` for the next 2 hours — including the user's main turn at 09:50:24, which is why it picked `lfm-2.5-2.6b:free`.
**Why this is a false positive:** pi-claude uses `claude-bridge` (pi's own Claude OAuth/subscription). The "operation was aborted" is a generic abort/timeout from the cascade, not a real rate-limit signal from Anthropic. The router has no way to distinguish "the stream was aborted because the parent fanout crashed" from "the provider rate-limited me" — it treats them identically for any non-free, non-local provider.
**Impact:** This is the **live bug** the user is seeing: "it still goes for the minimax-m2.7 free model." Even after the Ollama crash cascade resolves, pi-claude stays in a 2-hour cooldown, so `tactical` (and `strategic`) can't pick Sonnet. Combined with F4 (scored GLM-5.2 invisible), the high-quality tier is completely locked out until the cooldown expires.
**Fix direction:** (a) Distinguish abort/timeout from explicit rate-limit signals — an `AbortError` or "operation was aborted" without a real 429/Retry-After header should NOT trigger a long cooldown. (b) claude-bridge providers may warrant a shorter cooldown or a "subscription, not rate-limited" classification. (c) At minimum, `isPaidCloudRateLimitFailure` should not treat a bare `provider_error` as a rate limit for a bridge/subscription provider — require an actual rate-limit marker.

### F11 — The router still requires provider/key knowledge it shouldn't need (architectural principle violation)

**Status: RESOLVED (2026-09-02, commit `fd2e68e`).** `stripProvider()` now consults pi's registered provider IDs (`setPiRegisteredProviders` in `src/metrics.ts`) in addition to PROVIDER_MAP and cfg.providers. `index.ts` publishes `getRegisteredProviderIds()` to the metrics module at session_start and after `registerGroupModels`. pi-registered providers like `pi-claude`, `claude-bridge`, and extension providers are now recognized — GDPval/price inference resolves their model ids. (The deeper principle — using pi's registry as the capability/price source too — remains a future direction; this fix addresses the recognition gap that was blocking pi-claude.)

**The user's point:** "PI knows the models and will give the router the information about them. USE That! pi-claude seems to know how to connect and therefore Sonnet is available."
**Where this principle is violated:**
- **F3**: `getCheapestCloudModels()` filters by `lookupPrice(ref)`, which returns `null` for any provider the router doesn't have pricing data for (mistral-zai, pi-claude, anything pi registers that isn't in the OpenRouter pricing cache). The router should ask pi (or `modelRegistry`) for cost/capability, not require its own pricing cache.
- **F4**: `registerGroupModels` skips a whole provider if pi already knows one model — but the router's own `getM`/`lookupGdp`/`effCost` then can't price/score the unregistered variants because they aren't in the router's scan cache. The router treats pi's registry as a candidate source but doesn't use it as the capability/price source.
- **`PROVIDER_MAP`** (`src/providers.ts`) is the router's own hardcoded provider list. `pi-claude` is NOT in it, which breaks `stripProvider` (returns the full `pi-claude/claude-sonnet-5` instead of stripping to `claude-sonnet-5`) and means the router has no provider definition for pi-claude. The model-map only has `claude-bridge/claude-sonnet-5`, not `pi-claude/claude-sonnet-5`.
**The architectural fix:** the router should treat pi's `modelRegistry` as the single source of truth for (a) which models exist, (b) what provider each belongs to, and (c) — via the `Model` object's fields — capability/price where available. The router's own `PROVIDER_MAP`, `openrouter_pricing` cache, and `cfg.providers` should be fallbacks/overrides, not the primary path. Right now the router uses pi's registry for *discovery* (candidate list) but its own stale caches for *filtering* (price, gdpval slug, health) — and the two disagree, which is why high-quality pi-registered models (Sonnet, GLM-5.2) are invisible to the very groups that should pick them.

---

## 3. What is correct (the roborev-reviewed fixes are sound)

These were verified during the review and are correctly implemented:

- **completeSimple reach-through** (`178b1ff`, roborev HIGH-1): `stream-orchestrator.ts:229-236` correctly calls `registry?.runtime?.completeSimple?.(model, ctx, options)`, matching the existing `hostStreamSimple` pattern for `streamSimple`. The public `ModelRegistry` facade does not expose `completeSimple` in the pinned harness; the private `runtime` field is the only path.
- **Overflow recursion guard** (`178b1ff`, roborev HIGH-2): `stream-orchestrator.ts:~554` calls `ctx.recordSoftFailure(ref)` before recursing into larger-context candidates, and the `tried` list is now `[...largerCandidates]` (dropping the overflowing model) instead of re-including it. This prevents unbounded recursion on unparseable overflow errors.
- **Test config injection** (`3468a43`, roborev HIGH-1 of job 417): the integration tests in `test/overflow-try-larger.test.ts` now write the test config to `<tmpDir>/.pi/router-config.json` (the cwd-layer override that `loadLayeredConfig` actually reads under vitest), not to `dist/router-config.json`. The hard assertion `calledIds.some(id => id !== 'small' && id !== 'big') === false` proves the tests exercise the mock candidates, not incidental production refs.
- **Cloud fallback opt-in gate**: `if (allowCloudFallback && cfg && cache && completeSimple && findModel)` — all four must be present (data minimization preserved).
- **Cloud fallback uses pi's auth**: the router no longer rolls its own HTTP client + key resolution (the old `CloudClient` that threw "No API key for provider" is deleted). `completeSimple` delegates to pi's `ModelRuntime`, which uses pi's auth store.

---

## 4. Capability verification: can the router trigger GLM-5.2 / Sonnet?

**Yes, conditionally — but not via the cloud fallback, and not reliably in the current state.**

| Path | Can reach GLM-5.2? | Can reach Sonnet? | Notes |
|------|--------------------|-------------------|-------|
| Classifier → `code_complex` → `tactical` | ✅ if F4 fixed | ✅ via `pi-claude/claude-sonnet-5` | `tactical` (min_gdpval 600) has 14 candidates when the scored `glm-5-2` is registered, including `mistral-zai/glm-5-2` (1497), `mistral/mistral-medium-3.5` (933), `openrouter/z-ai/glm-5.2:free` (1497). `method:'best'` sorts by gdpval desc → GLM-5.2 or Sonnet wins. |
| Classifier cloud fallback | ❌ (F3) | ❌ (F3) | Only free OpenRouter models; subscription/bridge models filtered out by `lookupPrice === null`. |
| HINT `pi-claude/claude-sonnet-5` | ✅ (with colon) | ✅ | `detectHintDirectly` + HINT path works; pi-claude resolves via `api=claude-bridge`. |
| HINT fallback candidates | ⚠️ only `zai-glm-5-2` (unscored) | ✅ `pi-claude/claude-sonnet-5` | The HINT fallback list comes from `modelRegistry.getAvailable()` — pi-claude IS in pi's registry (pi registers it itself via claude-bridge). |

**Sonnet IS reachable (correction of the first review's error).** `pi-claude/claude-sonnet-5` resolves successfully via `tryStream` — `provider=pi-claude api=claude-bridge baseUrl=claude-bridge` (confirmed in `~/.pi/logs/router.log` at 09:50:23.932 and used successfully at 09:50). pi registers `pi-claude` itself as a built-in Claude subscription provider; the router does **not** need a `pi-claude` key in `auth.json` or `router-config.json` — pi owns that connection. The first review's claim that "the user has no pi-claude key → Sonnet is unreachable" was **wrong**: it applied the old `CloudClient` mental model (router needs its own keys) to a provider that pi registers and authenticates itself. This is exactly the architectural flaw the refactor removed — **pi knows the models and gives the router the information; the router must use that, not require duplicated keys** (see F11).

**Why Sonnet still wasn't picked for the user's last turn (09:50:24):** a parallel subagent fanout at 09:50:23 overwhelmed Ollama (crash) and then triggered a retry storm across every cloud model. `pi-claude/claude-sonnet-5` returned `provider_error` (the stream was aborted by the cascade), and `isPaidCloudRateLimitFailure` classified that as a rate limit → **2-hour cooldown ending 11:51** (see F10). So at the main turn, `pi-claude/claude-sonnet-5` was in `isLimited` cooldown and filtered out of `tactical`'s candidate list. With the scored GLM-5.2 also invisible (F4), `tactical` had no high-gdpval candidate left and cascaded to the `fallback` group → `lfm-2.5-2.6b:free`.

**GLM-5.2 reachability for this user:** `mistral-zai/glm-5-2` is free (subscription), in pi's registry (as `zai-glm-5-2`), high quality (1497). Fixing F4 (slug resolution for `zai-glm-5-2` → `glm-5-2` score) would make it reachable via the normal `tactical` path. Fixing F3 would make it reachable via the cloud fallback too.

---

## 5. Recommended fix order (for the next implementation pass)

1. **F10** (false-positive rate-limit cooldown on pi-claude) — **the live bug the user is seeing right now.** `isPaidCloudRateLimitFailure` treats a bare `provider_error` (cascade-induced abort) as a 2-hour rate limit for pi-claude. Without this fix, Sonnet is locked out for 2 hours after any subagent fanout that aborts. Highest urgency.
2. **F11** (use pi's registry as the source of truth, not the router's stale caches) — the architectural principle the user stated. The router uses pi's registry for discovery but its own `PROVIDER_MAP`/`openrouter_pricing`/`model-map` for filtering, and they disagree for pi-registered providers (pi-claude, mistral-zai). This is the root cause that makes F3, F4, and the `stripProvider` issue all surface.
3. **F4** (slug resolution `zai-glm-5-2` → `glm-5-2`; or register the scored variant) — makes GLM-5.2 reachable via the normal routing path for every `code_complex`/`design`/`planning`/`fallback` classification.
4. **F1** (template literals) — trivial, 7 lines, immediately improves triageability.
5. **F3** (subscription models priced as $0 in `getCheapestCloudModels`) — makes the cloud fallback actually useful when Ollama is down (uses the free-to-the-user GLM-5.2 instead of the rate-limited OpenRouter free tier).
6. **F5** (apply escalation to the hard-coded fallback) — restores the "bump to a bigger model" safety net in the all-fail case.
7. **F7** (quality floor on cloud fallback) — prevents the classifier from routing to the lowest-quality free tier.
8. **F6** (optional colon in HINT) — usability.
9. **F8/F9** (cache freshness, operational rate-limit awareness) — hygiene + resilience.

---

## 6. Sync with actual implementation (verification log)

- `src/content-classifier.ts`: read in full; F1 bug confirmed at 7 lines; cloud-fallback flow confirmed at ~520-580; escalation gating at ~498 confirmed.
- `src/discovery.ts`: `getCheapestCloudModels` read at 380-425; price filter confirmed (F3); `getFreeModels` confirmed.
- `src/stream-orchestrator.ts`: classifier wiring at 195-250; `completeSimple` reach-through at 229-236 (correct); overflow recursion guard at ~547-560 (correct).
- `src/metrics.ts`: `lookupPrice` at 491-535 (F3 root cause); `lookupGdp`/`resolveSlug` at 184-247; `getM` at 321-365 (subscription `cost_per_m:0` handling); `calculateScore` at 388 (pure `gdpval/10`).
- `src/routing.ts`: `resolveGroup` at 660-720; `min_gdpval` filter at 103-104 (strict, null fails); `resolve` cascade at 492-510; `allDiscoveredRefs` at 246 (registry-first).
- `src/model-health.ts`: `UNHEALTHY_AT=2`, `HEALTH_DECAY_MS=15min`; all glm health records stale at review time → not demoting.
- `index.ts`: `registerGroupModels` at 2390-2480 (Ü1 guard confirmed); `registerFreeModelOnDemand` at 1686 (free-models-only, Ü1-guarded).
- `dist/router-config.json`: `dynamic.classifier_cloud_fallback: true` confirmed; `tactical.min_gdpval: 600`, `method: best`; `fallback.min_gdpval: 0`, `method: tiered`.
- `~/.pi/agent/models.json`: `mistral-zai` has exactly 1 model `zai-glm-5-2` (F4 confirmed).
- `~/.pi/agent/auth.json`: keys for `mistral`, `mistral-zai`, `openrouter`. (pi-claude needs NO entry here — pi registers and authenticates it itself via claude-bridge; the first review's "no pi-claude key" claim was wrong.)
- `dist/.cache/scan-cache.json`: 120 models, 349 gdpval scores, 872 prices; `mistral-zai/glm-5-2` present with `cost_per_m:0` and gdpval 1497.55.
- `~/.pi/logs/router.log`: production log for 2026-09-02 05:37–09:26 reviewed; the 09:26 sequence (5 cloud models all failing, fallback→tactical→minimax-m2.7:free) is the exact failure the user observed.
- Tests: `test/overflow-try-larger.test.ts` config injection (cwd-layer) and hard assertion confirmed at lines 103-130, 216; `test/classifier-cloud-fallback-opt-in.test.ts` opt-in gate preserved.

All findings in this document are cross-referenced to the exact source lines or log timestamps above.
