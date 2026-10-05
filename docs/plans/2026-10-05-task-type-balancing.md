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

## Phase 5 — Token consumption (investigated 2026-10-05; staged measures)

**Findings (router.log + usage_log, 2026-10-02..05):**

1. `bulk_read` and the tool-result shrinker **work** (11 blocked full-file
   reads, ~10 shrinks, e.g. 8607→2138 chars) — but they only limit context
   GROWTH. They do nothing about RESENDING the accumulated context.
2. The distribution shows the burner: median stream ~600–900 tokens, tail
   up to 229k–424k. On 10-04, 5.66M tokens flowed over 1430 streams with a
   median of 595 — the tail carries nearly everything.
3. Root cause: Pi auto-compacts only at `contextWindow − reserveTokens`
   (default 16384). The mid-tier model's 1M window therefore compacts
   effectively never; sessions grow to 200–400k and every tool step
   (~20–25 per turn) resends the full context. At 20 steps × 200k that is
   ~4M tokens per turn.
4. Pi reports `usage.cacheRead`/`cacheWrite`; the router logs neither.
   The registry lists cacheRead for the mid-tier model at 0.14 vs 1.4 input
   (10× cheaper) — IF provider caching engages, the resend burn is
   already 10× lower than list price suggests. Engagement is unknown.

**Measures (staged, generic — PAYG users benefit equally):**

- **5a Measure caching.** Log `cacheRead`/`cacheWrite` per stream; extend
  `usage_log` with cached input (also makes the `/router cost` windows
  more accurate). Red-first test. Decides whether 5b is urgent or the
  burn is already dampened.
- **5b Effective context budget.** The global `reserveTokens` cannot
  distinguish a 1M window from a 200k one. Instead: a configurable
  per-model/per-group context budget (e.g. ~150–200k for the 1M-window
  model), enforced by the router via Pi's `ExtensionContext` compaction
  controls when the projected context exceeds it. Minimal first cut: a
  narration hint recommending `/compact` past the threshold. Default
  conservative; values in the user layer.
- **5c Threshold review** for `bulk_read` (block_lines 350) and the
  shrinker — small expected effect; only after 5a/5b measurements.

**Owner decision points:** budget values (user layer); whether proactive
compaction may run mid-turn (Pi supports chained compaction entries at
`turn_end`) or only between turns.

---

## Out of scope

- Changing the `best_quality_window` or the `tactical` cap defaults.
- Any proactive reading of the Claude 5h utilization (upstream route
  closed; detection stays reactive via the reset-time parse).
