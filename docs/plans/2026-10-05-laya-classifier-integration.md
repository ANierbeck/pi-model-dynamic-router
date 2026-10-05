# Laya Classifier Integration Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Integrate Laya (Convai Innovations, Apache 2.0 — a local, non-LLM "System One" decision model, ~15–40 ms per pass) as a new local classifier stage `classifier_laya`, **disabled by default**, with a verified interface (spike), transparent failover, observability, tests, and a Golden-Set benchmark whose numbers feed the later fine-tuning go/no-go (owner decision — NOT part of this plan).

**Architecture:** Laya slots into `classifyPrompt` right after the deterministic HINT path and before the opt-in cloud chain — it is the first *model-based* stage because it is local, fastest, and never lets prompt content leave the machine even when cloud fallback is configured. Target chain: `HINT-Regex (unchanged) → Laya (local, confidence-gated) → cloud chain (opt-in, unchanged) → Ollama (unchanged) → static keywords (unchanged)`. Operating mode: verified by spike, lean sidecar (`laya-serve`, Jev-compatible `/v1/systemone` HTTP endpoint) — in-process ONNX only if the spike shows a decisive advantage (owner decision recorded: "Spike zuerst, Tendenz Sidecar").

**Tech Stack:** laya pip package + `laya-serve` (sidecar candidate), HTTP client via existing fetch, typed config in `router-config.json` (+ user/project override layers), Vitest red-first per AGENTS.md §4, Golden-Set harness as a pinned script.

**Owner decisions already made (2026-10-05):**
1. Spike first, tendency sidecar.
2. `classifier_laya.enabled` defaults to **false**; activation only after the Golden-Set benchmark justifies it (separate owner decision).
3. Scope = integration only; the fine-tuning pipeline (brief §4.8) is a documented outlook, decided after Task 8's numbers.
4. The spike runs on a DEDICATED feature branch (`laya-spike`), separate from the usual development cadence: it is exploratory (local installs, measurements, research doc), and the standard path continues meanwhile with the mutation-testing triage (docs/plans/2026-10-04-mutation-survivor-triage.md). The spike branch merges back via PR only when its research doc is done (owner decision 2026-10-05).

**Out of scope:** fine-tuning, temperature re-calibration *training*, cloud-Jev stage, any change to HINT handling (deterministic, runs before, must never come from a classifier — pinned by existing tests, re-pinned in the golden set).

---

## Background the implementer needs

- Laya facts (from `~/Downloads/laya-integrations-brief-für-das-pi-model-dynamic-router-projekt.md`, self-contained): typed interface — send State (text/JSON) plus typed questions; per question returns `choice` (option + per-option probabilities + confidence), `score`, or `noul`. All questions answered in ONE forward pass. **Zero-shot is weak** (base checkpoints ~0.36 vs. ~0.32 random on typed decisions; competitive only after fine-tuning) — that is exactly why this ships disabled. Weak above ~20 choice options — our 9 categories are the sweet spot. Context limit checkpoint-dependent, tested at 512 tokens per question → State must be truncated. Calibration as shipped is poor (ECE 0.466; 0.081 after temperature fitting) → the confidence gate's absolute numbers must be treated as uncalibrated until the benchmark says otherwise. NOT operable via Ollama.
- Router chain today: `classifyPrompt` (src/content-classifier.ts:395) → HINT/compaction/momentum deterministic paths → cloud chain (opt-in, 15 s/candidate) → Ollama (`mistral-nemo:latest` primary, `gemma2:2b` fallback) → static keyword fallback (opt-in). `ClassificationResult` = `{ category (9 valid + fallback), reason, confidence? }`; `ClassificationSourceInfo.source` strings appear in `/router status` (pattern: `'ollama:<id>'`, `'cloud:<provider/id>'`).
- Low-confidence semantics today: **verify during Task 4** how the existing stages treat sub-threshold confidence (fall-through vs. fallback-category) and mirror the safer variant; the brief's rule "confidence < threshold → Kategorie fallback" is the *activation-time* default to benchmark against, not a reason to weaken the chain while disabled.

---

### Task 0: Spike — verify laya-serve against reality (no router code)

**Files:** Create `docs/research/2026-10-05-laya-spike.md` (results), throwaway venv outside the repo.

**Steps:**
1. `python3 -m venv ~/venvs/laya-spike && pip install laya` — pin and record the exact package version; download the **multilingual** checkpoint, pin its version string (never "latest").
2. Start `laya-serve`; probe `/v1/systemone`: document request schema (State, question types, options array), response fields for a `choice` question (chosen option, per-option probabilities, confidence), error codes, rate limits.
3. Measure on this machine (M3 Max, 36 GB): cold start time, RAM (sidecar process), per-request latency over ≥100 requests (incl. p50/p95), behavior at 512-token State (find the truncation boundary), behavior with all 9 categories as options.
4. Quick in-process check (no commitment): `receptron/laya` + `onnxruntime-node` load time + RAM. Only to have numbers for the sidecar-vs-in-process comparison table.
5. Write `docs/research/2026-10-05-laya-spike.md` with: pinned versions, request/response examples (verbatim JSON), measurements, the mode recommendation with data, and the exact endpoint contract Task 2 codes against.
6. Commit (docs-only). **Gate: if the spike kills sidecar mode, stop and re-ask the owner before continuing.**

### Task 1: Config + types (red-first)

**Files:** Modify `src/types.ts` (near the classifier config fields), `router-config.json` (documented example, **enabled: false**), test: new `test/classifier-laya-config.test.ts`.

**Steps:**
1. Write the failing test pinning: default absent-config → stage inactive; `classifier_laya` object shape `{ enabled: boolean; endpoint?: string (default from spike); checkpoint: string (pinned, required when enabled); timeout_ms?: number (default 1500); confidence_threshold?: number (default 0.8) }`; config validation errors on `enabled: true` without `checkpoint`.
2. Watch it fail (function/field does not exist).
3. Implement types + validation + the `router-config.json` example block. Suite green, tsc clean, commit.

### Task 2: Laya client + probe (red-first)

**Files:** Create `src/laya-classifier.ts`; test: `test/laya-classifier.test.ts`.

**Steps:**
1. Red-first: client tests against a stubbed `/v1/systemone` (the spike's verbatim contract): builds ONE choice question from the 9 `VALID_CATEGORIES` with the option descriptions taken from the existing classification prompt (`src/classification-prompt.ts` — do not re-invent criteria); truncates State to the spike-measured budget; classifies failures: connection refused / timeout (→ stage unavailable, negative availability marker with TTL analogous to the 501 marker), HTTP error (→ unavailable), malformed response (→ unavailable, log once).
2. Probe (like `classifier-fallback-probe.ts`): a REAL classification task (a known prompt with an obvious category), never a bare ping; probe result gates the stage per session with a TTL.
3. Implement `src/laya-classifier.ts`: `isLayaAvailable()`, `probeLaya()`, `classifyWithLaya(prompt, ctx)` → `ClassificationResult | null`, source string `laya:<checkpoint>`.
4. Suite green, tsc clean, commit.

### Task 3: State truncation helper (red-first)

**Files:** Modify `src/laya-classifier.ts`; tests in `test/laya-classifier.test.ts`.

**Steps:** Red-first for `truncateState(prompt, ctx, budget)`: keeps head + tail, preserves HINT/whitespace integrity of the prompt head, drops the context block first, then the prompt tail; verify token budget against the spike's measured limit. Implement, green, commit.

### Task 4: Chain integration in classifyPrompt (red-first)

**Files:** Modify `src/content-classifier.ts` (chain order, after deterministic paths, before cloud); test: extend `test/classifier-fallback-chain.test.ts`.

**Steps:**
1. Red-first chain tests: Laya stage runs BEFORE the cloud chain and BEFORE Ollama; `enabled: false` (or absent) → byte-identical chain behavior (existing tests must stay green untouched); Laya unavailable/timeout → transparent fall-through to cloud/Ollama with the chain's existing narration; low-confidence result → follow the *verified current low-confidence semantics* of the chain (see Background) — document the choice in the test; HINT inputs never reach Laya (deterministic path wins first — pin it).
2. Implement the stage insertion; `ClassificationResult.reason` synthesized from the probability distribution (e.g. top-2 categories with their probabilities).
3. Suite green, tsc clean, commit.

### Task 5: Observability + status (red-first)

**Files:** Modify `src/content-classifier.ts` (source string), `src/commands.ts` (`/router status` classifier line via the existing `formatClassifierStatus` seam); tests: extend `test/router-status-classifier-line.test.ts` + `test/global-log-tag.test.ts` as needed.

**Steps:** Red-first for: source `laya:<checkpoint>` recorded in `ClassificationSourceInfo`; `/router status` shows the stage with availability + latency + threshold like the existing stages; narration respects existing leak rules (`classifier-narration` tests). Implement, green, commit.

### Task 6: README "Data handling & privacy" + docs (docs-only)

**Files:** Modify `README.md` (privacy section: Laya is local-only, no credentials, no data transfer — ADR-0022 untouched), `AGENTS.md`/`CLAUDE.md` (entry points), `CHANGELOG.md` (`[Unreleased]`), `docs/config-override.md`.

**Steps:** Write the docs; commit. (§4 exception: docs-only.)

### Task 7: Golden-Set harness (red-first, no activation)

**Files:** Create `test/golden/classifier-golden-set.json` (prompts + expected categories), `scripts/laya-golden-benchmark.ts`; test: `test/laya-golden-benchmark.test.ts` (harness logic, not live calls).

**Steps:**
1. Build the golden set: ~120–200 REAL prompts — German + English, code/design/planning/exploration mixes, short continuations ("weiter", "Machen!"), compaction-continuations, and explicit HINT cases (which must resolve deterministically, never via Laya — pin it). Labels: owner-curated where ambiguous, current-chain consensus otherwise. Record label provenance per entry.
2. Red-first the harness logic against stubs: accuracy, per-category confusion matrix, latency p50/p95, confidence distribution + ECE. Output: markdown report.
3. Run once against the live sidecar (manual, not CI): results land in `docs/research/2026-10-05-laya-spike.md` (appendix) — **these numbers are the fine-tuning go/no-go input for the owner.**
4. Commit. Mutation-testing note: `content-classifier.ts` is NOT in the nightly `mutate` scope (decision core only) — adding it is part of the separate mutation-triage plan's Task 7, not this plan.

### Task 8: Quality gates + release readiness (per AGENTS.md §1)

**Steps:** full suite green + `tsc --noEmit` clean + dist rebuild (src changed) + §1 code review (fresh context, v1.6.1..HEAD) + release-prep PR. Version: this integration is the natural **1.7.0** candidate (new opt-in functionality, backwards compatible — final version number is the owner's call, per the 1.6.1 precedent). Activation of the stage (flipping the default / the owner's own `router-config.user.json`) remains a separate owner decision AFTER the benchmark numbers are on the table.

---

## Success criteria

- `classifier_laya` exists end-to-end: config → client → probe → chain → status, **disabled by default**, byte-identical behavior while disabled.
- No prompt content leaves the machine while the stage is the active classifier; HINT stays deterministic-first (pinned).
- Failover never weakens the existing chain (cloud → Ollama → static unchanged and green).
- Golden-Set benchmark report exists with accuracy, confusion matrix, latency, ECE — the owner can decide on fine-tuning from numbers, not vibes.
- All regression tests red-first per §4; red evidence named in each commit.

## Explicitly deferred (decided after Task 8's numbers)

- Fine-tuning pipeline (labeled-set collection from classifyCache/logs, System One Studio on Mac, re-calibration with temperature fitting, checkpoint version bump) — brief §4.8.
- Activation (enabled: true) and threshold tuning.
- Cloud-Jev stage (brief §3's future bracket).
