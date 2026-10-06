# ADR-0025: No hardcoded models — everything derives from the models Pi uses

## Status

Accepted as a principle (owner directive, 2026-10-06). The implementation
plan in [`docs/plans/2026-10-06-no-hardcoded-models.md`](../plans/2026-10-06-no-hardcoded-models.md)
is **proposed**; the phases listed there need the owner's go before they land
(two of them change shipped defaults for every installation).

Extends [ADR-0021](0021-no-scan-discovered-model-registration.md) (Pi's
registry is the single source of truth for the cloud model inventory) and
[ADR-0022](0022-router-never-touches-auth-json.md) (credentials are Pi's)
from *registration* and *credentials* to **selection**: which model may be a
candidate, which model judges the prompt, which model costs what.

## Context

The router is a public package installed on machines whose Pi setups look
nothing like the author's. Every time shipped code or shipped default config
names a concrete model, the router makes a claim about *someone else's*
machine that it cannot verify.

The concrete incident that triggered this ADR (externally reported
2026-10-06, fixed in PR #39): a user without an OpenRouter key had every
cheap group and the classifier's cloud chain filled with dead
`openrouter/*` candidates. Root cause: the shipped
`providers.openrouter.free_models` list (7 hardcoded refs) was treated as
usable on **config presence alone**. Pi knew perfectly well that the provider
had no credentials; the router never asked. PR #39 closed the five admission
points for that one list. It did not remove the list — and the same class of
bug will recur wherever a shipped literal can still influence a decision.

### Audit (2026-10-06, verified against `main` = `6c8c89f`)

| # | Where | What is hardcoded | Influences |
|---|---|---|---|
| 1 | `src/content-classifier.ts:160,305` | `DEFAULT_MODEL = 'mistral-nemo:latest'`, `FALLBACK_MODEL = 'gemma2:2b'` | **which model judges every prompt** (local leg) |
| 2 | `router-config.json` `model_groups.dynamic` | `classifier_model` / `classifier_fallback` (same two models) | same, shipped as default |
| 3 | `src/escalation.ts:94,162`, `src/commands.ts:137` | `ollama/gemma2:2b`, `ollama/mistral-nemo:latest` defaults | loop-detection model; `/router` display |
| 4 | `router-config.json` `providers.openrouter.free_models` | 7 OpenRouter refs | **candidate admission** (the bug) |
| 5 | `router-config.json` `model_metrics` | 7 `claude-bridge/*` per-model cost sentinels | **ranking** (PR #36 P1: one missing entry made opus outrank sonnet) |
| 6 | `router-config.json` `exclude.models` | 14 specific OpenRouter refs (pinned by `test/config-excludes-guardrail-blocked.test.ts`) | candidate removal for everyone, based on the author's workspace policy |
| 7 | `router-config.json` `providers` | `claude-bridge: subscription`, `openrouter: pay_per_token` | billing semantics of two named providers |
| 8 | `router-config.json` `non_agent_model_prefixes` | `mistral-small-`, `magistral-small-`, `ministral-`, `voxtral-`, `codestral-` | admission (agent-capable gate) |
| 9 | `router-config.json` `gdpval_builtin` | 37 slug → score entries | scoring only (see class B below) |
| 10 | `src/ollama-gdpval.ts` | family → score table incl. speculative "future" families | scoring only |
| 11 | `src/model-matcher.ts` | family token table | identity matching only |

Already correct (the pattern to extend): the **cloud** classifier leg is
derived — `selectClassifierCandidates` ranks whatever is in
`cache.available_models` and the scan-time probe (ADR-0006) keeps only
candidates that actually classify correctly. Learned permanent failures are
blocked dynamically (ADR-0008). Provider credentials are asked from Pi
(`hasConfiguredAuth`, PR #39).

## Decision Drivers

- The owner's rule: **no hardcoded models in the system, and that includes
  the flow that decides which model to use** — the classifier is the most
  consequential selection in the router and was left out until now.
- Public package: shipped defaults must be correct on a machine the author
  has never seen.
- Pi already owns the inventory, the credentials, the list prices and
  per-model capability flags (`reasoning`, `input`, `contextWindow`,
  `cost`); the router should ask, not assume.
- The author's personal preferences are legitimate — in the **user layer**
  (`router-config.user.json`), where they are explicit choices, not
  defaults imposed on everyone.

## Options Considered

### Option A — Keep curated lists, gate each use (PR #39 style)
Add a credential/availability check wherever a literal can leak. Cheap, and
it was the right emergency fix. **Rejected as the strategy**: it is
whack-a-mole. The audit found five admission points for one list; every new
consumer of a literal needs its own gate, and forgetting one reproduces the
bug.

### Option B — Remove literals, derive everything, ratchet with a guard (chosen)
Shipped code and shipped default config name no model that can admit,
select, rank or exclude. Replacements are derived from Pi's registry, scan
data, probes and learned state. A **ratcheting guard test** makes the
direction irreversible: the baseline of tolerated literals only shrinks.

### Option C — Move all literals into a separate "recommended models" data file
Same coupling, different filename. **Rejected**: the problem is the claim
about foreign machines, not the file it lives in.

## Decision

1. **Rule.** Shipped source and shipped default configuration must not name
   a concrete model (ref, id, slug or family) in any position where it can
   **admit** a candidate, **select** a model (classifier, escalation,
   fallback), **rank** it (cost sentinels, quality order) or **exclude** it.
   What a model *is* and what it can do comes from Pi's registry and from
   observation (scan, probe, learned state).

2. **Three classes are explicitly allowed** — so the rule stays enforceable
   instead of aspirational:
   - **A — Provider adapters.** Protocol knowledge about *how* to read a
     provider's catalog or detect a local runtime (`capabilities.ts`
     extractors, `ollama/` / `lm-studio/` local-kind checks, `providers.ts`
     scan endpoints). They describe providers, never pick models. Local-kind
     checks should converge on the single `isLocalProvider` predicate.
   - **B — Annotation data that can never admit.** Name-keyed lookup tables
     that only *score or identify* models Pi already supplied:
     `gdpval_builtin`, the Ollama family-score priors, the family-token
     table in `model-matcher.ts`. Invariant (pinned by a test): **no entry
     in these tables ever creates a candidate**; a model absent from them
     degrades to a conservative default, never to a failure.
   - **C — User layer.** `router-config.user.json` may name anything: pins,
     exclusions, billing declarations, free-model lists. These are the
     user's explicit choices about their own setup.

3. **Derivation replaces each literal.** Details and ordering are in the
   plan; the decisions are:
   - **Classifier (local leg)** — derived exactly like the cloud leg:
     candidates are the local models Pi/Ollama reports, filtered by
     capability (a `completion`-capable, non-embedding model; the existing
     `structured output is unavailable` 501 mark keeps excluding models
     without schema support), ordered by size, and **verified by the shared
     classification probe**. The probed, ordered list is persisted
     (`cache.classifier_local_models`); primary = first, fallback = second.
     `classifier_model` / `classifier_fallback` remain as optional **user
     pins** (like `classifier_cloud_model` already is), with no shipped
     value. Before the first probe completes, a *provisional* candidate (the
     smallest completion-capable local model) is used; with no local model
     at all the chain proceeds to the cloud leg and finally the static
     classifier, as today. The escalation loop-detector and `/router`
     display read the same derived list.
   - **Free models** — the shipped `free_models` list is removed. Free
     candidates come from what Pi registers (cost 0 under credentials) and
     from `:free`-tier entries the scan finds for **credentialed**
     providers. `free_models` stays as an optional user-layer list for
     providers Pi cannot enumerate.
   - **Subscription cost sentinels** — per-model `model_metrics` sentinels
     are replaced by a **rule**: a model of a `billing: subscription`
     provider gets an effective cost of `ε × (Pi's list price)`, preserving
     the quota-burn ordering (cheaper-per-token burns less quota) without
     naming any model. A model never mentioned anywhere (the PR #36 P1
     case) is thereby handled structurally.
   - **Exclusions** — shipped `exclude.models` is emptied. Permanent
     failures are what the list encodes (403 "agentic harness only", 404
     guardrail violation); ADR-0008's learned blocklist derives exactly that
     from observed behavior. Taste-based exclusions belong to the user layer.
   - **Provider billing** — a user fact (how *you* pay), declared in the
     user layer; shipped defaults carry no provider entries beyond
     documented examples.
   - **`non_agent_model_prefixes`** — derive from Pi's per-model flags where
     they carry the signal; otherwise remain a user-layer heuristic with an
     empty shipped default plus learned blocking. This one needs a spike
     (see plan, Phase D) before the decision is final.

4. **Enforcement: a ratcheting guard.** `test/no-hardcoded-models.test.ts`
   scans `src/**` and the shipped `router-config.json` for model literals
   outside classes A–C and fails on any occurrence not in a checked-in
   baseline (`scripts/hardcoded-model-baseline.json`). The baseline starts
   at the audit above and **may only shrink** — a PR that adds an entry
   fails review by construction. The shipped-config half is structural, not
   textual (no `free_models`, no `model_metrics`, no `classifier_model` /
   `classifier_fallback`, empty `exclude.models`).

5. **AGENTS.md carries the rule** (§9), per §2: rules governing agent
   behavior live in versioned docs, not only in memory.

## Consequences

**Easier**
- The OpenRouter bug class is structurally impossible: nothing shipped can
  name a model Pi does not have.
- The classifier works on machines without `mistral-nemo` / `gemma2:2b`
  (today: a guaranteed failed hop per classification on such machines).
- New models rank correctly with zero config edits (no per-model sentinel to
  forget, no `gdpval_builtin` entry required for admission).

**Harder / costs**
- **Behavior change for existing installs** (1.7.0 line): users who relied
  on the shipped `free_models`, the shipped exclusions, or the shipped
  billing entries must declare them in the user layer. The owner's own user
  config already carries most of this; CHANGELOG states the migration.
- **Cold start**: the first classification after a fresh install uses the
  provisional candidate or the static classifier until the probe has run
  (the cloud leg already behaves this way).
- The probe costs a few local calls per scan; bounded by the same candidate
  cap as the cloud probe.
- `test/config-excludes-guardrail-blocked.test.ts` pins data that this ADR
  removes; it is retired and its intent (permanent failures never burn
  attempts) is carried by the ADR-0008 learned-blocklist tests.

**Out of scope**
- Making scores (`gdpval_builtin`) come from a live benchmark source — they
  stay annotation data (class B); the invariant is only that they never admit.
- Auto-detecting subscription billing from Pi's auth kind: that would require
  reading credential metadata, which ADR-0022 forbids.
