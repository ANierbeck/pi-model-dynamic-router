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

> **DONE (2026-10-07, branch `adr0025-cde-derived`).** C1–C3 landed: derived
> candidates + probe (`src/classifier-local-probe.ts`), flow wiring (user pin >
> probed list > provisional > none), `FAMILY_RANK`/constants/config keys
> removed. Deviations from the text below: the orchestrator passes only the
> user's pins and `classifyPrompt` derives from `cache` itself (same result,
> one resolution point); a probe re-run policy (force / candidate change /
> 24 h TTL) was added because scans run on every session start; the scan-time
> *matcher's* local model (the real `FAMILY_RANK` caller) now derives from
> size, see CHANGELOG.

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

> **DONE (2026-10-07):** spike report below; outcome (c); the owner
> pre-authorized finishing D, so the implementation landed with the report.

- **Spike (1 h):** inspect what Pi exposes per model (`reasoning`, `input`,
  `compat`, tool-call flags) and what the failure classifier already learns
  ("does not support tools"). Report whether any available signal separates
  agent-capable models (tool calling) from chat-only/OCR/voxtral-style models.
- **Outcomes:** (a) a Pi flag exists ⇒ derive, drop the list; (b) only
  learned failures ⇒ empty shipped default + ADR-0008-style learned
  "no tool support" block; (c) neither ⇒ list stays but moves to the user
  layer with an empty shipped default and a documented caveat. Owner decides
  after the spike report; no code before that.

### Spike report (2026-10-07) — outcome (c)

> **DONE.** Evidence below; every claim is re-checkable with the command next
> to it. Outcome chosen by the evidence: **(c) neither** — empty shipped
> default, the list moves to the user layer, README documents the caveat.

**Question.** Does anything Pi or the scan exposes per model separate
agent-capable models from the `non_agent_model_prefixes` families
(`mistral-small-`, `magistral-small-`, `ministral-`, `voxtral-`,
`codestral-`)?

| Signal | Finding | Re-check |
|---|---|---|
| Pi `Model` / `BaseModel` (pi-ai `types.d.ts`) | Fields: `id, name, api, provider, baseUrl, input, inputLimits, cost, headers, reasoning, thinkingLevelMap, promptCache, contextWindow, maxTokens, samplingParams*, compat`. **No tool-calling / function-calling flag.** `input` is modalities (`text`/`image`) only. `compat` is per-API wire-format quirks (`supportsStore`, `thinkingFormat`, …) — it DOES carry tool-*wire-format* flags (`requiresToolResultName`, `supportsToolSearch`, `supportsStrictTools`, pi-ai `types.d.ts:638-763`), but these describe HOW tool calls must be encoded for that API, not WHETHER a model is a reliable agent; `MistralConversationsCompat` has a single field (`supportsMidConvoSystemMessages`). `type?: 'chat'` separates chat from image/classifier models, not agent-capable from chat-only. The canary in `test/agent-capability-tier.test.ts` scans only `BaseModel` and `Model` (not the `compat` interfaces) — a capability flag added there re-opens the question; a `compat` flag alone does not. | `test/agent-capability-tier.test.ts` → "spike canary" reads the installed `types.d.ts` and fails if a tool/function field appears on `BaseModel`/`Model` (host upgrades re-open this question). |
| Scan capabilities (`src/capabilities.ts`, `cache.available_models[].capabilities`) | `ModelCapabilities` = `vision, reasoning, contextWindow, maxTokens` (+ the C1 local fields). Ollama `/api/show` reports a `tools` capability, but it is **not extracted** and only covers local models — the filtered families are cloud. Since ADR-0022 the router no longer scans the Mistral catalog at all (cloud inventory = Pi's registry), so a Mistral `capabilities.function_calling` flag is not available either. | `grep -n "tools" src/capabilities.ts` (comment only). |
| The flag, even if present, would not separate the families | The 2026-09-27 evidence (`src/agent-capability.ts` header): the models **do** call tools — the failure is quality (35+ consecutive 0–220-char `toolUse` turns; a final turn that announces a result and stops). To the best of our knowledge these families advertise function calling in their provider's model metadata (not re-fetched in this round — the catalog is no longer scanned). A capability flag says "can emit a tool call", not "reliable as the main agent". | evidence block in `src/agent-capability.ts`. |
| Learned failures (ADR-0008, `error-signatures.ts`) | `no-tool-support` ("does not support tools", `Filter by Tool Compatibility`) is classified verdict **`request`**: request-dependent, *never blocks* (the model works without tools — it still classifies). And the incident streams **finish normally** (`stopReason: stop`, non-empty): no failure fires at all ("No failure detection can fire on these"). | `src/error-signatures.ts:47-61,221`; `provider-breaker.ts:40`. |

**Verdict.** (a) fails — no flag exists; (b) fails — nothing is ever learned,
and a learned tool-incapacity would be a per-request verdict by design. The
list encodes an *empirical quality judgement about named families on a
specific workload* — a user preference in the sense of ADR-0025 class C, not
data Pi can supply. It therefore moves to the **user layer**:

- shipped `router-config.json`: no `non_agent_model_prefixes` key (absent =
  filter off, the documented off-switch);
- `src/agent-capability.ts` evidence comment, README section and CHANGELOG
  document the caveat and the user snippet;
- pins: shipped config carries no list; with the shipped default the former
  families are NOT dropped by name while a user-supplied list still gates
  (red against the prefix-list default); spike canary above.

**Behavior change (1.7.0, migration).** Installs that relied on the shipped
default stop filtering those five families in routing groups until they add
the list to `router-config.user.json`. The dynamic-config resync copies the
key from the static layers, so a stale generated dynamic file cannot keep the
old list alive. The owner's user config needs
`"non_agent_model_prefixes": ["mistral-small-", "magistral-small-", "ministral-", "voxtral-", "codestral-"]`
to keep today's behavior (parent step — not applied by this round).

## Phase E — Closure

> **DONE (2026-10-07):** baseline **0 entries / 0 occurrences** (ceiling pinned
> at 0). AGENTS.md §9 already carried the rule (landed with an earlier phase);
> it now also records the closed baseline. The ADR index already listed 0025.
> README (pins/user-layer table, classifier requirements), CHANGELOG
> migration notes and TODO.md updated. The final §1 review over the whole
> range stays a pre-release gate and is NOT part of this branch.

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
   **ANSWERED (2026-10-07, Phase C review):** smallest-first shipped as the
   default (the probe verifies correctness, so a too-weak model drops out);
   users who prefer the old larger-primary order pin `classifier_model` /
   `classifier_fallback` (CHANGELOG carries the restore snippet and the order
   flip note).
