# Plan: No hardcoded models (ADR-0025)

> Implements [ADR-0025](../adr/0025-no-hardcoded-models.md). Status:
> **proposed** — each phase needs the owner's go. Target release line:
> **1.7.0** (behavior change for existing installs; see Phase B/C notes).
> All phases follow AGENTS.md §4 (red-first, tsc + suite green), §5
> (commits), §8 (PR flow, all three review endpoints read before merge).
> **No release action is part of this plan (§1).**

## Ordering rationale

The guard goes first so every later phase *ratchets* instead of drifting.
Config-only phases (B) are small and remove the incident class. The local
classifier (C) is the largest and most valuable piece — it is the flow the
owner called out explicitly — and goes second-to-last only because it needs
the most careful verification, not because it matters less. D is a spike.

```
A guard+baseline ─▶ B1 free_models ─▶ B2 sentinels ─▶ B3 exclude/providers
                                                        │
                       C local classifier (C1 select ▶ C2 wire ▶ C3 cleanup)
                                                        │
                                          D non_agent spike ─▶ E docs/closure
```

---

## Phase A — Ratcheting guard + baseline (no behavior change)

**Goal:** make "no new hardcoded model" a failing test before removing the old
ones.

- **A1. Shipped-config structural pins** — `test/no-hardcoded-models.test.ts`:
  parses `router-config.json`; asserts (initially via a baseline allowing the
  current violations) no `providers.*.free_models`, no `model_metrics`, no
  `model_groups.*.classifier_model|classifier_fallback`, empty
  `exclude.models`, no `providers.*` billing entries naming concrete
  providers.
- **A2. Source scan** — same test scans `src/**/*.ts` (non-comment string
  literals) for model-shaped literals: `provider/model` refs and
  family-prefixed ids built from the `model-matcher.ts` family tokens.
  Allowed classes (ADR-0025 §2): path allowlist for class A files
  (`capabilities.ts`, `providers.ts`) and class B tables
  (`ollama-gdpval.ts`, `model-matcher.ts`).
- **A3. Baseline** — `scripts/hardcoded-model-baseline.json` listing the 
  audit's current violations by `file:literal`. The test fails on any literal
  **not** in the baseline, **and** on any baseline entry that no longer
  exists (so removals must shrink the file — it is a true ratchet).
- **A4. Class-B invariant tests** — `gdpval_builtin`, Ollama family priors and
  the family-token table never produce a candidate: a registry without model
  X plus a `gdpval_builtin` entry for X ⇒ X absent from `allDiscoveredRefs`,
  the persisted dynamic groups, and the classifier candidates.

**Red-first:** add a bogus literal (`'gemma9-test'`) in a scratch commit and
observe the guard fail; add a stale baseline entry and observe it fail.
**Exit:** guard green on `main` with the audit baseline.

## Phase B — Config-only removals (the incident class)

> **DONE (2026-10-07, branch `phase-b-derived-configs`).** B1–B3 landed as
> three commits. Final baseline: **28 entries / 34 occurrences** (was 56 / 62;
> ceiling pin lowered to match). Findings: (B1) the persist path admitted
> scan-discovered `:free` refs on registry resolvability alone — now gated on
> `hasConfiguredAuth` like every other candidate; (B2) the claude-bridge
> registry costs are zeros, so order comes from the OpenRouter list-price
> backfill (`effCost = 1e-6 × list price`, constant fallback for unlisted
> models) — owner decision (a), 2026-10-07; (B3) both guardrail patterns were
> already `permanent` in `error-signatures.ts`, so the retired config list is
> replaced by `test/guardrail-learned-blocklist.test.ts`. The remaining
> baseline is the classifier flow (Phase C), `non_agent_model_prefixes`
> (Phase D) and the non-selecting entries listed under Phase C.

### B1. `free_models` derived, shipped list removed
- Verify first (spike, 30 min): does Pi's registry + the scan already surface
  OpenRouter `:free` models for a credentialed user without the shipped list?
  (`scan-runner.ts` adds `:free` entries to `cache.available_models`; Pi's
  builtin catalog may include them.) If a gap remains, derive it in the scan
  (free-tier entries of **credentialed** providers) — not in config.
- Remove `providers.openrouter.free_models` from `router-config.json`;
  `free_models` stays supported as a user-layer key.
- **Red-first:** with the shipped list removed and a credentialed fake
  OpenRouter provider exposing a `:free` model through the registry/scan, the
  free model is still a candidate; with no credentials, none is.
- Baseline shrinks by 7 refs.

### B2. Subscription cost sentinel by rule
- Replace the 7 `model_metrics` sentinels with a rule in `metrics.ts`:
  provider `billing: subscription` ⇒ `effCost = ε × listPrice(Pi registry)`;
  fallback chain unchanged (registry price → OpenRouter backfill → constant
  sentinel for unpriced).
- Verify first: that the claude-bridge registry entries carry usable
  `cost` values (the bridge may register zeros). If so, derive order from
  the OpenRouter list-price backfill that `lookupListPrice` already has, or
  from `contextWindow`/`reasoning` flags as tie-breakers; decide with the
  owner before coding.
- **Red-first:** a subscription-provider model that appears nowhere in config
  (the PR #36 P1 shape — "sonnet-5-5 without a sentinel") must still sort
  before a pricier sibling in the quality window.
- Baseline shrinks by 7 `model_metrics` entries. Keep the sentinel constant
  as a documented fallback, not per-model data.

### B3. Exclusions and provider billing to the user layer
- Empty shipped `exclude.models`; keep the *machinery* (ADR-0009 union
  merge). The owner's `router-config.user.json` already carries the personal
  exclusions; copy the 14 former shipped refs there during migration so the
  owner's behavior does not change.
- Retire `test/config-excludes-guardrail-blocked.test.ts`; carry its intent
  in an ADR-0008 test: a model returning 403 "agentic harness only" / 404
  "free-model-training-violation" is blocked after the first permanent
  failure and never burns more attempts (verify the failure classifier
  already treats these as permanent; if not, add the pattern — it is a
  *failure* pattern, not a model name).
- Remove shipped `providers.claude-bridge` / `providers.openrouter` billing
  entries; document the `billing` key with an example in README and add it to
  the owner's user config. (Ties into the TODO.md backlog item "/router config
  command" — first-run guidance can point there.)
- **Red-first:** shipped-config pin fails while the lists exist; learned
  blocklist test fails until the 403/404 patterns are classified permanent.
- CHANGELOG: explicit **Changed** entry with the migration snippet.

## Phase C — Derived local classifier (the flow that decides)

> **Baseline triage from the Lane A review (2026-10-07):** the 56-entry
> baseline splits into three groups for later rounds. (1) The 13
> `src/local-llm.ts` entries (`FAMILY_RANK` regex table, lines 85–95) are the
> Phase C deletion target — a ranking table is a rank/select violation.
> (2) **Non-selecting entries** that are safely tolerated but are NOT model
> choices, so later rounds should remove or reclassify them instead of
> "deriving" anything: `src/slug-matcher.ts:29` (`'zai-'`, a vendor prefix
> used for normalisation — class A in spirit), `src/scan-runner.ts:274` (log
> text) and `src/classification-prompt.ts:48-57` (3×, few-shot examples
> inside the classifier prompt). (3) Residual blind spot of the token-based
> scanner (documented, not a defect): bare model ids whose family token is
> missing from `MODEL_FAMILIES` or not id-initial (e.g. `chatgpt-4o`, `phi4`,
> `o3-mini`) are only caught when written as `provider/model` refs.
> **Open scope question for the owner:** `model-map.yaml` is shipped into
> `dist/` and contains name-keyed `~` entries (e.g. `voxtral-*: ~`) that make
> `lookupGdp` return null. ADR-0025 §4 limits the guard to `src/**` and
> `router-config.json`, so it is out of scope today — the owner decides
> whether to classify it explicitly as class B (annotation, never admitting)
> or to add it to the guard's scope in a later phase.

### C1. Candidate selection + probe (`src/classifier-local-probe.ts`)
- `selectLocalClassifierCandidates(cache, cfg)`: from
  `cache.available_models` where `provider === 'ollama'` (and LM Studio if
  scanned): drop embedding-only / non-completion models using the capabilities
  already extracted (`capabilities.ts` Ollama extractor), drop models in
  `cache.classifier_no_schema` within TTL, drop excluded/blocked models; order
  by parameter size ascending (small = fast), then by name for stability.
- `probeLocalClassifierCandidates`: reuse the shared prompt/golden set from
  `classifier-fallback-probe.ts` (single source of truth for the prompt
  surface), same timeout and candidate-cap discipline; persist the ordered
  working list as `cache.classifier_local_models`, called from the scan
  right after the cloud probe.
- **Red-first:** (1) a registry with only `foo:3b` and `bar:9b` — never the
  old literals — yields `foo:3b` primary / `bar:9b` fallback; (2) a model that
  answers 501 is skipped and marked; (3) no Ollama models ⇒ empty list, chain
  proceeds to cloud/static.

### C2. Wire the flow
- `content-classifier.ts`: `DEFAULT_MODEL` / `FALLBACK_MODEL` removed.
  Primary/fallback = user pin (`classifier_model` / `classifier_fallback`) ›
  `cache.classifier_local_models[0/1]` › provisional (smallest
  completion-capable local model) › none (skip the local leg).
- `stream-orchestrator.ts` passes the derived list; `escalation.ts`
  (`ollama/gemma2:2b` defaults at lines 94/162) takes the head of the derived
  list or disables LLM loop detection (rule-based path already exists);
  `commands.ts:137` displays derived heads (`none yet` while unprobed).
- Remove `classifier_model` / `classifier_fallback` from shipped
  `router-config.json`; keep the keys in `types.ts` as optional pins; update
  `index.ts:488-491` accordingly.
- **Red-first:** a classification on a machine whose only local model is
  `foo:3b` calls `foo:3b` (and never `mistral-nemo` / `gemma2:2b`); with a
  user pin set, the pin wins; with no local models, the cloud leg is tried
  first without an Ollama availability hop.

### C3. Cleanup and removal of the residue
- Delete the two constants and every comment block that justifies them as
  "the default" (keep the 501-incident history in the ADR trail, not as live
  code claims). Update `docs/adr/0009` cross-reference ("bundled classifier
  model as source of truth") with a superseded-in-part note.
- Baseline shrinks by the classifier entries. **Exit:** classifier flow
  contains zero model literals.

## Phase D — `non_agent_model_prefixes` spike (decision, then maybe code)

- **Spike (1 h):** inspect what Pi exposes per model (`reasoning`, `input`,
  `compat`, tool-call flags) and what the failure classifier already learns
  ("does not support tools"). Report whether any available signal separates
  agent-capable models (tool calling) from chat-only/OCR/voxtral-style models.
- **Outcomes:** (a) a Pi flag exists ⇒ derive, drop the list; (b) only
  learned failures ⇒ empty shipped default + ADR-0008-style learned
  "no tool support" block; (c) neither ⇒ list stays but moves to the user
  layer with an empty shipped default and a documented caveat. Owner decides
  after the spike report; no code before that.

## Phase E — Closure

- **AGENTS.md §9** (rule, per §2): shipped code/config names no model that can
  admit, select, rank or exclude; allowed classes A–C; the guard test is the
  gate; baseline only shrinks.
- ADR index entry; README section "Declaring billing / free models / pins in
  `router-config.user.json`"; CHANGELOG migration notes for 1.7.0.
- Final review via the `requesting-code-review` skill over the whole range
  (§1 gate) before any release is even proposed.
- Update TODO.md: tick the "hardcoded models" item; link this plan.

## Verification (every phase)

- Red evidence named in the PR body per test (§4).
- `npx tsc --noEmit`, `npx vitest run` green; the guard test green with a
  baseline that is strictly smaller than before the phase.
- Live smoke on the owner's machine after Phase C: `/router` shows the
  derived chain; classification works with `mistral-nemo` *and* `gemma2:2b`
  uninstalled (temporarily pin an alternative or rename in a scratch Ollama
  home — do not remove the owner's models).

## Open questions for the owner

1. **B3 default change** — removing shipped exclusions and billing entries
   changes every install. Confirm the 1.7.0 line carries it (migration
   documented), or keep them one more minor with a deprecation warning?
2. **B2** — are the claude-bridge registry `cost` fields trustworthy enough to
   order subscription models, or should ordering come from the OpenRouter
   list-price backfill? (Answer comes from the B2 spike; flagging early.)
3. **C1 ordering** — "smallest verified-correct model first" optimizes
   latency. Prefer a quality bias (largest that answers under N seconds) for
   classification accuracy? Default proposal: smallest first, since the
   probe already verifies correctness.
