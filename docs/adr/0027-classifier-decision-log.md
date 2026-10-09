# ADR-0027: Classifier decision log

- Status: accepted (2026-10-08)
- Deciders: owner, agent
- Context: docs/plans/2026-10-08-classifier-decision-log.md
- Related: ADR-0024 (task-type balancing), ADR-0025 (no hardcoded models)

## Context

The router's content classifier decides, for every prompt, which group of
models serves it — the most consequential selection in the router. Yet
nothing recorded *what* was decided from *what input*: router.log proves the
chain is healthy (latency, fallbacks, availability — 0 failed chains since
2026-10-04, median per-turn miss 0.6 s), but the category, confidence,
reason and prompt of a decision were never persisted. Classification
accuracy is invisible, and a second classifier (Laya, see
docs/plans/2026-10-05-laya-classifier-integration.md) could not be compared
against the known one fairly — its planned position before the cloud chain
would stop the known chain from running at all, so only a shadow/replay
comparison on identical inputs is honest.

## Decision

1. **One JSONL record per `classifyPrompt` call**, appended to
   `~/.pi/logs/classifier-decisions.jsonl`: stage (hint / compaction /
   momentum / cache / llm-local / llm-cloud / static / fallback), the full
   candidate chain with per-attempt outcome and a *machine-classified*
   failure reason (never the raw error body — provider responses can echo
   secrets), the raw classification vs the final one with the
   post-processing steps between them (low-confidence-inherit,
   fallback-inherit), the routed group, and timing.
2. **Privacy gate `store_text`** (ADR-0025 kin — user intent, re-synced into
   the dynamic config): `"none"` (shipped default) stores lengths and a
   12-hex sha prefix only — joinable, not reconstructable; the model's
   reasons are prompt-derived text and are nulled too. `"full"` (owner
   user layer) additionally stores the prompt and both context texts — the
   replay input. File mode 0600, own size rotation (20 MiB × 3 default).
3. **Fail-open**: the record is appended after routing returns; an
   unwritable location or a torn write never changes a classification.
   A missing `options.cfg` (direct unit tests) logs nothing.
4. **Threading via the existing `AsyncLocalStorage` holder**: the trace
   rides the same holder as the classification source, so overlapping
   `classifyPrompt` calls (subagent fan-out) each see only their own chain.
5. **Replay over re-simulation** (Phase 3): the known classifier's
   decisions come from the log itself; `scripts/classifier-replay.ts`
   builds a corpus from full-text records plus backfilled session files and
   replays it against any candidate endpoint over a generic HTTP contract
   (`POST /classify {prompt} → {category, confidence?}`) — no Laya
   specifics in the repo (ADR-0025).

## Consequences

- Classification accuracy becomes measurable offline: disagreement reports
  against the known decisions, and a golden set becomes cheap to build
  (replay disagreements + a stratified sample of the session backfill).
- Every prompt the owner classifies is hashed durably; text only with
  explicit opt-in, in a 0600 file under the owner's home.
- Turn-level outcome joins (what the classification *led to*) and a live
  shadow mode remain future phases (2 and 4) — explicitly not required for
  the Laya spike.
