# Plan: classifier decision log — make "known vs. Laya" comparable

> Registered 2026-10-08. Prerequisite for the Laya spike
> ([laya-classifier-integration](2026-10-05-laya-classifier-integration.md),
> Task 0 and Task 7). All phases follow AGENTS.md §4 (red-first, tsc + suite
> green), §5, §8. **No release action is part of this plan (§1).**

**Goal:** For every classification the router makes, persist enough to answer
two questions later, offline: (1) *what did the known classifier decide, why,
and how long did it take?* (2) *what would a different classifier (Laya) have
decided on the exact same input?* Plus a first, honest quality signal.

## Why now — what the logs cannot answer today

Measured on 2026-10-08 against `~/.pi/logs/router.log`:

- **No per-turn decision line exists.** The log records *that* a classifier
  chain ran (`[classifier] Cloud fallback trying 8 model(s)`) and *which
  model answered*, never the category, confidence, reason or the prompt. The
  question "how good is the classifier" is unanswerable from logs — only
  availability and latency are.
- **Counters are in-memory only** (`getClassificationCounts`, reset on
  restart and at local midnight) and count the *post-processed* category.
- **The golden-set plan (Laya Task 7) assumes data that does not exist.**
  It says labels come from "current-chain consensus" and the later
  fine-tuning set from "classifyCache/logs" — but the cache is 64 entries /
  5 min, and the logs carry neither prompts nor decisions.
- **Laya's planned position would destroy the comparison.** The integration
  plan puts Laya *before* the cloud chain. Once active, the known chain no
  longer runs, so "known vs. Laya" can only be measured in a **shadow mode**
  in which the known chain decides and Laya merely answers on the side.

### Defects found while reading the classification path (fixed in this plan, §7)

1. **`MIN_CONFIDENCE` (0.5) gates only the local Ollama path**
   (`content-classifier.ts:630`, inside `tryClassify`). `tryCloud` — the path
   that actually runs, cloud-first since 2026-09-27 — returns `parsed` without
   any confidence check. Confidence therefore means different things
   depending on the path; any Laya confidence-gate calibration must not be
   compared against an ungated baseline unaware of this.
2. **A cloud reply with a structurally valid JSON but an invalid category is
   skipped silently** (no `else` after `isValidFullClassification`, no log) —
   the local path maps it to `fallback` with a warning. Invisible today.
3. **`noteSource('ollama:<m>')` fires before the reply is validated**
   (`:593`), so `/router status` can credit a model whose output was
   rejected.
4. **Cache hits lose provenance.** `classifyCache` stores the result only;
   a cache hit reports `source: 'cache'` with no trace of which classifier
   produced it.

**Resolution (owner, 2026-10-08):** implement 1–2 now — the shared
`applyConfidenceGate` guards both paths, and an invalid-category cloud reply
warns and moves on to the next candidate (skip beats mapping to `fallback`:
a model that invents a category is better replaced than trusted). **Defect 3
was retracted** after an empirical check: every path that rejects a reply
overwrites the source at the next `noteSource`, so `/router status` can
never end up crediting a rejected model — the probe ends at
`source: 'fallback'`. **Defect 5 (found while implementing):** `tryCloud`
never wrote the classification cache at all (`if (cloudResult) return`), so
the cache only ever served the (often dead) local path — cloud results are
cached now, and results derived from the caller's previous category are
never cached on either path (the key is the prompt alone; a cached inherited
result would leak one conversation's context into another).

## Design

### One record per `classifyPrompt` call — `classifier-decisions.jsonl`

Written at the single choke point (`classifyPrompt`, the same place that
already feeds `countClassification`), **after** `inheritPreviousCategory`, so
raw and final are both visible. Separate file `~/.pi/logs/classifier-decisions.jsonl`
(own size rotation) — not `router.log`, which stays a human narration log.

```jsonc
{
  "v": 1, "ts": "2026-10-08T21:22:02.032Z",
  "turn": "<id>",            // correlation id, minted at the call site (Phase 2)
  "proc": "pi-model-router-fork/59038",   // same tag as router.log
  "stage": "llm-cloud",      // hint | compaction | momentum | cache | llm-local | llm-cloud | static | fallback
  "input": {
    "chars": 214, "words": 31, "sha": "9f2c…",           // sha256, 12 hex — dedupe key
    "context": { "lastCategory": "code_complex", "isCompaction": false,
                 "hasContextBlock": true, "lastModelLimited": false },
    "text": null             // per store_text: null | snippet(120) | full — see Privacy
  },
  "chain": [                  // ordered attempts, incl. skips — the real "why this model"
    { "ref": "openrouter/…", "outcome": "skipped", "why": "not-in-registry" },
    { "ref": "mistral/ministral-3b-latest", "outcome": "ok", "ms": 612 }
  ],
  "raw":   { "category": "fallback", "confidence": 0.4, "reason": "…", "scores": null },
  "steps": ["low-confidence-inherit"],   // post-processing actually applied, in order
  "final": { "category": "code_complex", "group": "complex", "hint": null },
  "ms": 640,
  "shadow": []                // Phase 4: [{ name, category, confidence, scores, ms, error }]
}
```

Design decisions:

- **`raw` vs. `final` are both recorded** with an explicit `steps[]` list
  (`low-confidence-inherit`, `invalid-category-to-fallback`, `spurious-hint-skip`,
  `fallback-inherit`, `momentum`, …). The 2026-10-05 diagnosis (60 % of turns
  classified `fallback`) was only reconstructible by code reading; with
  `raw` + `steps` it is a one-line query.
- **`chain[]` records every attempt**, including candidates skipped for
  registry/credentials and failures with a coarse reason class
  (`timeout | http-4xx | http-429 | parse | invalid-category | spurious-hint`)
  — never raw error bodies.
- **`scores`** is `null` for LLM stages and the per-option probability map for
  Laya (Laya's `choice` answer carries it) — the field exists from v1 so
  the schema does not change when Laya lands.
- **`group`** is the result of `getGroupForCategory` at decision time, i.e.
  with the user's `category_groups` applied — the comparison is on routing
  consequence, not just on the label.
- **Trace collection** extends the existing `AsyncLocalStorage` holder
  (`callSource`) from `{ source }` to a per-call trace object, so subagent
  fan-out cannot cross-attribute attempts (the reason the holder exists).
- **Fail-open, always.** A write error (EACCES, disk full, rotation race)
  must never alter or delay a classification: wrapped, swallowed after one
  `warnLog` per process.

### Privacy (README "Data handling & privacy", new ADR-0027)

The record contains prompts only if the user opts in:

`classifier_log: { enabled, store_text: "none" | "snippet" | "full", max_bytes, keep }`

- **Shipped default: `enabled: true`, `store_text: "none"`** — metadata,
  hash, lengths, decisions; nothing that reveals content. Useful for every
  user (fallback rate, stage mix, chain failure rate, latency) and replay-less.
- **Owner's user layer: `store_text: "full"`** — required for replay. The file
  stays local, mode `0600`, never uploaded. It lives under `~/.pi/logs/`
  (outside any repository); a project-local copy, if one is ever written,
  falls under the existing `.pi/` entry in `.gitignore`.
- Precedent: `router.log` already carries an 80-char prompt prefix on HINT
  lines (`appendRawLog` in `stream-orchestrator.ts`). This plan does not widen
  what the *default* log reveals.
- `sha` is a dedupe key, **not** an anonymization: short prompts ("ok") are
  trivially brute-forceable. Documented as such.

### Outcome join and the quality signal (Phase 2)

Classification quality has no ground truth in production. What *is*
observable, joined by `turn` as a second record type
(`{"type":"outcome","turn":…}`):

- the model/group that finally served (and how many cascade hops it took),
- the `stopReason`,
- **correction signals**: an explicit model switch (`MHINT`) or `HINT:` on the
  *next* user turn, a manual `/model` change — "the router picked X, the user
  immediately overrode to Y".

These are **proxies, not accuracy**. The report labels them as such. Real
accuracy comes only from the golden set (below) — the log makes that set
cheap to build.

### Shadow mode (Phase 4)

`classifier_shadow: { enabled, stages, timeout_ms }` plus a tiny interface

```ts
interface ShadowClassifier {
  name: string;                                   // e.g. "laya:<checkpoint>"
  classify(input: ClassifierInput): Promise<{ category: Category; confidence?: number;
                                              scores?: Record<Category, number> }>;
}
```

- Runs **after** the known chain has returned its decision, fire-and-forget
  with its own timeout, results appended to the same record's `shadow[]`
  (record is flushed when the shadow settles or times out). It can neither
  delay nor change routing — pinned by test.
- Default `stages: "all-non-hint"` — momentum, cache and fallback-inheritance
  are classification decisions too ("≤ 4 words inherits the last category" is
  a heuristic Laya might beat); HINT stays out, it is deterministic.
- No Laya code in this plan: the interface is the seam. Laya's Task 2 client
  registers itself as a `ShadowClassifier`; until then the array is empty.
- Names come from config/registry, never hardcoded (ADR-0025).

### Replay and the corpus (Phase 3)

`scripts/classifier-replay.ts <jsonl|sessions-dir> --classifier <impl>`:
feeds recorded inputs (`store_text: full` required) through any
`ClassifierInput → Result` implementation and prints a markdown report:
agreement matrix between recorded `final` and the replayed answer,
per-category confusion, latency p50/p95, confidence histogram, and — the
useful part — the **disagreement list** (the only entries that need owner
labels).

**Backfill — a corpus exists today.** `~/.pi/agent/sessions/` holds
**3,671 real user prompts in 443 session files** (measured 2026-10-08), with
the prior user message and last assistant snippet reconstructible from the
same file. The replay script reads them directly (read-only) and runs the
known chain over them to produce the baseline labels — so the Laya spike can
start without waiting weeks for the live log to fill (the live LLM-stage
volume is only ~40–90 classifications/day). Live records then give the
*forward* corpus with true provenance (real cache hits, real cascade state).

The golden set of Laya Task 7 is built from: disagreements between replayed
implementations + a stratified random sample, owner-labeled, with provenance
per entry. That replaces "current-chain consensus" as the labeling source.

## Phases (each its own commit, one PR for 0–3)

### Phase 0 — ADR-0027 + config types (docs + types only)
`docs/adr/0027-classifier-decision-log.md` (schema v1, privacy defaults,
fail-open, why a separate file); `classifier_log` / `classifier_shadow` in
`src/types.ts` and a documented block in `router-config.json` (shipped
`store_text: "none"`). §4 exception: docs/types only, stated in the report.
Config-layer pin: default config has `store_text: "none"` (privacy regression
gate, like `config-release-log-level`).

### Phase 1 — decision record at the choke point (red-first)
Tests first, each driven RED against the unmodified `classifyPrompt`:
1. One record per call for **every** stage: hint, compaction, momentum,
   cache, llm-local, llm-cloud, static, fallback — correct `stage`.
2. `raw` ≠ `final` cases: local low-confidence inherit, invalid category →
   `fallback`, `fallback-inherit` (raw `fallback`, final = lastCategory,
   `steps` names it).
3. `chain[]` order and outcomes incl. `skipped` (registry, credentials) and
   a failing-then-succeeding cascade; error bodies never copied.
4. `store_text` modes: `none` → no prompt-derived string anywhere in the
   record (assert over `JSON.stringify`); `snippet` ≤ 120; `full`.
5. Fail-open: unwritable path, throwing writer → classification result
   byte-identical, one warning.
6. Concurrency: two overlapping `classifyPrompt` calls keep separate traces
   (the subagent fan-out case that motivated `callSource`).
7. Cache hit keeps `origin` (source that produced the cached entry) — fixes
   defect 4; invalid-reply path no longer credits the model (defect 3).
Implementation: trace object in the `AsyncLocalStorage` holder; writer module
`src/classifier-decision-log.ts` (JSONL, `0600`, size rotation with its own
`max_bytes`/`keep`, atomic line append like `logger.ts`).

### Phase 2 — turn id, outcome join, correction signals (red-first)
Mint `turn` in `StreamOrchestrator` before `classifyPrompt`; emit the
`outcome` record from the existing stream-finish / MHINT / `/model` paths.
Tests: outcome joins to the right turn under overlapping turns; a `HINT:` on
the next user turn emits a `correction` for the previous turn; no outcome
record for turns that never streamed.

### Phase 3 — replay + report script (red-first on harness logic)
`scripts/classifier-replay.ts` + `test/classifier-replay.test.ts` against
stub implementations (agreement, confusion matrix, percentile math, ECE
shared with Laya Task 7's harness — one implementation, not two). Session
backfill reader with a fixture session file. Live run is manual, not CI.

### Phase 4 — shadow hook (red-first)
`ShadowClassifier` seam in `classifyPrompt`; tests pin: result identical with
and without a shadow, shadow timeout/throw swallowed and recorded as `error`,
shadow never runs for HINT, shadow output lands in `shadow[]`, latency of the
classification unchanged (shadow settles after the return).

### Phase 5 — surfacing + docs
`/router classifier [days]`: stage mix, `raw`-`fallback` rate vs.
post-inheritance rate, chain failure rate, p50/p95, top disagreement
reasons — reads the JSONL, so it survives restarts (the in-memory counters do
not). README privacy bullet, CHANGELOG `[Unreleased]`, `docs/routing-flow.md`
gets the record's position in the diagram.

## Sequencing relative to the Laya spike

| Step | Needs | Delivers |
|---|---|---|
| Phases 0–1 | — | live forward corpus starts filling |
| Phase 3 | Phase 1 (schema) | spike can replay the 3,671 backfill prompts through Laya **offline, no router code** (spike Task 0 stays "no router code") |
| Phase 2 | Phase 1 | proxy quality signal; independent of the spike |
| Phase 4 | Phase 1 | needed only when Laya Task 2 (client) is written |
| Phase 5 | 1–3 | owner-facing summary |

**Minimum to unblock the spike: Phases 0, 1 and 3.** Phases 2/4/5 follow.

## Verification (every phase)
`npx tsc --noEmit`; `npx vitest run` green with the ratchet raised; coverage
thresholds unchanged; `npm run build` when `src/` changes; no
`no-hardcoded-models` finding (categories are not models; shadow names come
from config). `content-classifier.ts` is outside the nightly mutation scope —
adding it is deferred to the mutation-triage plan, and the new record logic
should be written so that branch-distinctive assertions (the B3 lesson) are
the default, not an afterthought.

## Owner decisions (all taken 2026-10-08)

1. **Defects 1–2:** implemented now (see above), not observe-first.
2. **Default `store_text`: `"none"` shipped**; the owner user layer runs
   `"full"` (replay needs the prompts). Reasons are prompt-derived text and
   are nulled at `"none"` — same gate, not just the input.
3. **Backfill scope:** router-era sessions, explicit `--sessions` include
   list (`--since 2026-09-27`); measured: 2,785 user prompts → **381 unique**
   in the router-fork project dir.
4. **Retention:** `max_bytes` 20 MB × `keep` 3, both configurable
   (`classifier_log.max_bytes/keep`).

## Status

- **Phases 0 + 1 + 3 shipped** (branch `classifier-decision-log`): config
  types + `classifier_log` re-sync key, the JSONL record at the
  `classifyPrompt` choke point, the replay harness
  (`scripts/classifier-replay.ts`) with session backfill.
- Phase 2 (turn id + outcome join) and Phase 4 (shadow hook) remain future
  work; the spike does not need them (known decisions come from the log,
  not from re-simulating the chain).
