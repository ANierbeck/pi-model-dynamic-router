# Task-Type Balancing Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Status:** Proposed — awaiting owner review. No code changes until the
owner approves this plan and ADR-0024.

**Goal:** Spread routed work across subscription tanks by *task type*
instead of letting a single mid-tier model absorb nearly every turn —
demanding work (complex code, design, planning) reaches the top-tier
models, routine work and its continuations stay on the cheaper tier. All
mechanisms ship generically (they must work for pay-per-token-only users
as well as for subscription users); personal routing preferences live in
the user-level `router-config.user.json`, never in the shipped defaults.

**Architecture:** Five phases, each independently useful. Phase 0 makes the
live decision observable; Phase 1 fixes a pricing defect that inverts the
ADR-0023 intent; Phase 2 lets continuation prompts inherit the previous
turn's category; Phase 3 makes the category→group mapping configurable;
Phase 4 (optional, default off) adds generic budget pacing; Phase 5 is a
separate token-consumption investigation.

**Tech Stack:** content-classifier (category → group), routing.ts group
filters + `best` quality window, config-loader layering, vitest.

---

## Evidence (2026-10-05)

Router log 2026-10-02..05 plus an offline simulation of the shipped config
against the real scan cache and Pi's registry prices.

1. **The current behavior is the ADR-0023 design.** `tactical` is capped at
   `max_gdpval: 1700`. zai-glm-5-3 (1653) stays; claude-sonnet-5-5 (1839)
   and claude-opus-5-5 (1900) are excluded. ADR-0023 assumed the Mistral
   tank was effectively free. It is not: the plan carries a monthly token
   cap, while the Claude subscription has no cost cap (only its 5h window).
   Stream counts: zai-glm-5-3 2778 streams vs claude-sonnet-5-5 55 since
   2026-10-03.

2. **~60% of turns are classified `fallback` and land in `tactical`.** The
   classifier works (cloud fallback `ministral-3b` succeeds), but the
   classification prompt defines `fallback` as *"Ambiguous, or a short
   continuation/confirmation of previous work"*
   (`src/classification-prompt.ts:70`), and `CATEGORY_TO_GROUP` maps
   `fallback → tactical` unconditionally (`src/content-classifier.ts:867`).
   A continuation of a design discussion therefore drops to the mid tier.
   Prior-category inheritance exists, but only for LOW-CONFIDENCE results
   (`src/content-classifier.ts:543`), not for the `fallback` category
   itself.

3. **Defect: opus outranks sonnet in `strategic`/`planning`.** ADR-0023
   intends sonnet-5-5 first (cheaper tier inside the 5% quality window),
   opus as escalation. claude-sonnet-5-5 has no `model_metrics` cost entry
   (only `claude-sonnet-5` and `claude-opus-5-5` carry the subscription
   sentinel `1.5e-6`), so its effCost is `'unknown'` and the window sorts
   it to the END of the pool — behind opus. Simulation output:
   `strategic: opus-5-5 [cost 1.5e-6], sonnet-5-5 [cost unknown], …`.

4. **Token volume is driven by tool loops.** ~20–25 streams per turn, each
   resending the full context. `usage_log` records `input + output` only
   (cached input excluded), so router-side token totals are a lower bound.

5. **Simulation vs. live divergence (open).** The offline simulation picks
   the legacy `claude-sonnet-5` (1603, inside the window, sentinel-priced)
   in `tactical`; live routing picks zai-glm-5-3. The live candidate
   ranking is not logged, so the cause is not observable today.

6. **Side observations.** claude-sonnet-5-5 carries a failure streak with a
   bridge `prompt-capture` signature (3×); the local Ollama classifier
   fails, so every turn spends an extra cloud classifier call.

---

## Owner decisions (2026-10-05)

- Direction: **split by task type** — not a fixed ratio, not a global
  tank inversion.
- Top-tier models (slower via the bridge) only for **demanding** tasks;
  fast routine work stays on the mid tier.
- Everything must **work for every user**; the owner's billing setup is
  not a design basis. Repo defaults stay neutral (pay-per-token users must
  not see cost increases); the owner's preferences go into the user layer.
- `code_complex` keeps its default group; the category→group mapping
  becomes configurable.

---

## Phase 0 — Observability (repo, generic)

**Files:** `src/routing.ts` (resolveGroup), `src/content-classifier.ts`,
tests.

1. Debug-level log of every group decision: group, ordered candidates
   with score / effCost / exclusion reason (cap, cost, cooldown, health).
   Red-first: a test asserting the line's content for a fixture group.
2. Daily classification-source/category counts visible in `/router`
   status (extend the existing classifier status line).
3. Investigate the sim/live divergence (Evidence 5) with the new log.
4. Verify claude-sonnet-5-5 stability via the bridge (`prompt-capture`
   signature) before routing more load to it.
5. Diagnose why the local Ollama classifier fails (separate fix if
   needed).
6. Find the cause of short-gap cache misses (owner decision 2026-10-05):
   of 110 misses on contexts >20k, many follow the previous step by
   6 s–1 min — not TTL expiry but a changed prompt prefix. Candidates:
   model switches within a session, router-injected text near the top of
   the context. If the router itself breaks the prefix, that is a cost
   bug and gets fixed before Phase 5 builds on cache signals.

## Phase 1 — Sonnet before opus (repo, generic, bug fix)

**Files:** `router-config.json` and/or `src/providers.ts`, tests.

1. Preferred generic fix: declare `claude-bridge` as `billing:
   'subscription'` so every bridge model resolves to sunk cost — new
   bridge models are covered automatically, no per-model sentinels.
   Before choosing it, establish why per-model sentinels were introduced
   (check `max_cost: 0` admission and `tiered` ordering effects).
2. Fallback fix: add the sentinel for `claude-sonnet-5-5` and a guard
   test that every routable bridge model in `gdpval_builtin` has a
   defined cost.
3. Red-first: a test showing `strategic`/`planning` order sonnet-5-5
   before opus-5-5 (RED today).

## Phase 2 — Continuations inherit the previous category (repo, generic)

**Files:** `src/content-classifier.ts`, tests.

1. When the classifier returns `fallback` and a previous category exists
   in the session context, inherit it (same mechanism as the
   low-confidence path). Without history, keep the configured default
   (`fallback → tactical`).
2. Guards: inheritance must not override HINT/compaction sources; decide
   whether inheritance decays (e.g. not across a session restart).
3. Red-first: "design turn, then 'ok, continue'" routes to the design
   group (RED today: tactical).

## Phase 3 — Configurable category→group mapping (repo mechanism, user values)

**Files:** `src/types.ts` (Config), `src/content-classifier.ts`,
`src/config-loader.ts`, README, tests.

1. New optional config key (e.g. `category_groups: { code_complex:
   'planning' }`) merged over the built-in `CATEGORY_TO_GROUP`. Unknown
   categories or groups are rejected with a warning at load time.
2. Defaults unchanged for everyone.
3. Overflow stays as today: a top-tier group's `fallback_groups` lead back
   to the mid tier when the subscription window is exhausted.
4. Red-first: user layer maps `code_complex → planning` and the resolver
   follows it (RED today: hardcoded).

## Phase 4 — Generic budget pacing (optional, default off)

Only if Phases 1–3 do not balance consumption enough.

- `providers.<p>.budget: { amount, unit: 'usd'|'tokens', period:
  'month', reset_day }` — works for capped subscriptions and for
  pay-per-token spend limits alike.
- The router compares its own counter to the linear target for the
  period and demotes a provider that runs ahead of pace.
- Prerequisite: `usage_log` must count cached input (`cacheRead`) — this
  also makes `/router cost` more accurate.

## Phase 5 — Token consumption: measure, then cache-aware compaction

**Measurement (Pi session files, zai-glm-5-3, 2026-10-02..05, list
prices from Pi's registry):**

| | tokens | cost | share |
|---|---|---|---|
| cacheRead (resent context, cache hit) | 473M | $66 | 72% |
| uncached input (cache misses) | 12M | $17 | 19% |
| output | 2M | $9 | 9% |
| **total, 3770 steps** | **487M** | **$92** | |

1. **Provider caching works** — 97.5% hit rate. The burner is not the
   hit rate but the VOLUME: on 10-04 the average context per step was
   ~180k over 1426 steps. Context size is the lever.
2. **`usage_log` undercounts ~40×** (11M recorded vs 487M processed): it
   logs `input + output` and ignores `cacheRead`. `/router cost` windows
   are wrong by the same factor.
3. `bulk_read` and the tool-result shrinker work (11 blocked full-file
   reads, ~10 shrinks) but only limit context GROWTH, not the resend.
4. Pi auto-compacts only at `contextWindow − reserveTokens` (default
   16384); with a 1M window, contexts reached 450k.
5. 110 misses on contexts >20k; part after idle gaps (TTL), many after
   seconds (prefix change — see Phase 0 step 6).

**Key insight:** a cold cache is the CHEAPEST moment to compact. After a
miss the next step pays full input price anyway, so compacting then
discards nothing already paid for; compacting on a warm cache throws a
paid cache away. Break-even example: compacting 200k on a cold cache
costs ~$0.28 once; every later step at 50k instead of 200k saves ~$0.02
→ break-even after ~13 steps, i.e. within one typical turn (20–25 steps).

**Owner decisions (2026-10-05):**
- Auto-compaction is **opt-in, default off** in the shipped config.
  Measurement is always on.
- Compaction runs **only between turns** (before the next user prompt is
  processed), never between tool steps of a running turn.
- A fresh session is only ever **suggested**, never forced (an earlier
  personal tool that stopped the session on cache loss was too harsh) —
  and even the suggestion is deferred to a 2.0 version (see 5c).

**Measures:**

- **5a Measure (always on).** Per step: context tokens, cacheRead share,
  step cost; per session: totals. Extend `usage_log` with
  `cacheRead`/`cacheWrite` and fix the `/router cost` windows (red-first:
  a usage with cacheRead must be counted). `/router` status line, e.g.
  "context 182k · cache 97% · ~$0.03/step".
- **5b Cache-aware compaction (opt-in).** Config (names illustrative):
  `context_budget: { enabled, soft_tokens, hard_tokens, cache_ttl_s }`,
  globally and per group.
  - cold cache (miss on the last step, or idle gap > `cache_ttl_s`) AND
    context > `soft_tokens` → `ctx.compact()` at the next turn boundary;
  - context > `hard_tokens` regardless of cache state → compact at the
    next turn boundary;
  - otherwise leave a warm cache alone.
  Uses Pi's `ExtensionContext.getContextUsage()` and `compact()`. When
  disabled, the same conditions only produce a hint ("compacting now
  would pay off: /compact").
- **5c Suggest a fresh start — DEFERRED to a 2.0 version** (owner
  decision 2026-10-05; not part of this plan's implementation). Recorded
  for later: when compaction stops helping (e.g. repeated compactions
  with a large summary, persistent misses), notify the user with a
  suggestion; a `/router fresh` command would start a new session with a
  handoff summary linked via `parentSession`. Pi allows `newSession()`
  only from user-invoked commands, so the router could never do this on
  its own.
- **5d Later options:** summarize via a cheaper model through the
  `session_before_compact` hook; threshold review for `bulk_read`
  (block_lines 350) and the shrinker.

---

## Out of scope

- Changing the `best_quality_window` or the `tactical` cap defaults.
- Any proactive reading of the Claude 5h utilization (upstream route
  closed; detection stays reactive via the reset-time parse).
