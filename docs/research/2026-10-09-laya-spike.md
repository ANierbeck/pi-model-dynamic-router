# Laya spike — first measurements (2026-10-09)

Branch `laya-spike`. Task 0 of `docs/plans/2026-10-05-laya-classifier-integration.md`,
MLX variant only (steps 0 and the measurement part of 3). Nothing here touches
router code; the wrapper lives in `spikes/laya-http/server.py` and speaks the
replay contract (`POST /classify {prompt} -> {category, confidence, ...}`).

## Start here (for a session that begins from scratch)

**What this is.** Laya is a small local "typed decision" model (no text
generation; it returns probabilities over fixed options in one forward pass).
The goal of the parent plan (`docs/plans/2026-10-05-laya-classifier-integration.md`)
is an opt-in, local classifier stage in front of the cloud chain. This
document records what the spike measured and decided so far. Nothing on this
branch (`laya-spike`, local only, not pushed) changes router behavior.

**State of the plan (2026-10-09).** Task 0 (spike) is partly done: MLX
variant measured, upstream `laya` / `laya-serve` / ONNX / process-management
comparison still open. Tasks 1-8 are not started. Quality is UNKNOWN: there is
no ground truth yet (see "What the replay can and cannot say").

**Files.**

| Path | Role |
|---|---|
| `spikes/laya-http/server.py` | Throwaway HTTP wrapper: `POST /classify {prompt, context?}` -> `{category, confidence, probabilities, ms}`. Reads category definitions from `src/classification-prompt.ts` at start-up (no copy). |
| `scripts/classifier-replay.ts` | Replays a corpus (session prompts and/or decision-log records) against any endpoint speaking that contract; reports agreement and disagreements. Context from full-text decision records is forwarded. |
| `src/classifier-decision-log.ts`, ADR-0027 | The decision log that produces the known-classifier labels (`~/.pi/logs/classifier-decisions.jsonl`, `store_text: "full"` needed for replay inputs). |
| `/tmp/laya-spike/` | Venv, server log and replay reports of the first run. Not versioned (reports contain prompt text). Recreate as below. |

**Reproduce.**

1. `uv venv --python 3.12 /tmp/laya-spike/.venv && source /tmp/laya-spike/.venv/bin/activate && uv pip install laya-mlx` (0.3.0 at the time; Apple Silicon only).
2. `python spikes/laya-http/server.py --port 8089` (downloads the pinned checkpoint, ~614 MB, on first start).
3. `npx tsx scripts/classifier-replay.ts --sessions ~/.pi/agent/sessions/<project-dir> --since 2026-09-27 --endpoint http://127.0.0.1:8089 --report /tmp/laya-spike/replay.json`
   (add `--records ~/.pi/logs/classifier-decisions.jsonl` once the decision log has data).

**Gotchas already paid for.**

- The model sees only `criteria` (labels) and ONE `instructions` string.
  Descriptions kept elsewhere never reach it.
- Never commit replay reports or `/tmp/laya-spike` content: they contain real
  prompts (pasted logs, diffs). Also never `git add -A` the `spikes/` dir
  without checking for `__pycache__` (it happened once; now ignored).
- The repo is public; every push is a publication (AGENTS.md §8).

## Pinned setup

| What | Value |
|---|---|
| Package | `laya-mlx==0.3.0` (+ `mlx==0.32.3`), Python 3.12 venv outside the repo |
| Checkpoint | `aac6fef/laya-multilingual-mlx`, revision `f2b4faf51023039425946074e2cf1361d2db11d5` (12 files, downloaded in 26 s) |
| Machine | Apple Silicon, macOS (Darwin 25.6) |

## Measured

| Metric | Result |
|---|---|
| Checkpoint load (warm disk cache) | 0.46 s |
| First `predict` after load | ~1.2 s (kernel compile); wrapper warms up at start |
| Round-trip via the HTTP wrapper, 120 real prompts | p50 12.2 ms, p95 49.8 ms, max 79.8 ms |
| Server-side predict | p50 11.5 ms, p95 49.0 ms (long prompts dominate p95) |
| Resident memory of the wrapper process | ~1.1 GiB RSS |
| Token budget | prompt head (instructions + 9 criteria) = 408 tokens; the model accepts inputs well past
  ~899 total tokens (architectural ceiling 8192 per encoder/config.json); the brief's
  1,024-token figure stands as a conservative truncation budget |
| Replay of the 383 unique router-era prompts, 4 workers | 9 s total, 0 endpoint errors |

The corpus is the router-fork project's session store since 2026-09-27
(2,785 user prompts, 383 unique at measurement time). 30 % of the unique
prompts exceed 1,500 characters (reviewer prompts, pasted logs); the
State-truncation boundary at 512 tokens was NOT characterized yet.

## Comparability: Laya does NOT get the production prompt by itself

The production classifier is a generative LLM that receives
`CLASSIFICATION_PROMPT` (`src/classification-prompt.ts`): detailed category
definitions with examples and rules (e.g. "Analyze / review / explain the code
-> code_complex, NOT exploration"), plus a background-context block (previous
user message, last assistant excerpt). Laya is a typed-decision model: it gets
`(text, question)` and returns probabilities over fixed options. Variants A
and B used category wording I invented, and no context. The wrapper (variant
C) now reads the definitions from the production prompt file at start-up
(single source, no copy) and the replay forwards the stored context texts
(`context` field of the contract) when a decision record has them. HINT
sections and the JSON answer format are dropped (HINTs are detected
deterministically before any classifier runs).

Results with variant C on the same corpus (385 unique prompts):

- categories: fallback 121, code_simple 74, simple 74, exploration 63,
  trivial 35, planning 7, design 5, code_complex 5, standard 1;
- confidence >= 0.8 for 85 prompts (22.1 %), but 51 of those are `fallback`
  and 39 of the 85 are prompts >= 1,500 characters — a confident `fallback`
  on a long paste is more likely a truncation artifact (instruction text
  and context compete for the 512-token window) than a decision;
- median confidence 0.46.

**Laya does not follow instruction text.** Same probes, three input shapes
(production instructions / one-line instruction / raw prompt, 8 probes,
anecdotal): "Debug why the retry loop deadlocks" -> `exploration` 0.87 with
the production instructions (production rule: `code_complex`); "Review this
diff ..." -> `exploration` 0.98 (production rule says explicitly NOT
exploration). Only "Design the new plugin API surface" was stable across all
shapes (0.97-0.99). The instruction string changes confidence strongly but
not toward the production rules, so the complexity axis cannot be steered by
prompt wording — it has to be learned from labeled data.

## Training data language: German or English? (measured 2026-10-09)

Question from the owner: if Laya is fine-tuned, in which language should the
labeled data be? Measured instead of guessed, on the 385 unique prompts of the
replay corpus (router-fork project sessions since 2026-09-27) with a
stop-word heuristic (German vs English function words in the first 600
characters; crude, but the split is not close):

| Slice | German | English | Other (too short / unclear / mixed) |
|---|---|---|---|
| All 385 prompts | 236 (61 %) | 133 (35 %) | 16 |
| Short prompts (< 200 chars), 180 | 163 | 3 | 14 |
| Long prompts (>= 1,500 chars), 119 | 5 | 113 | 1 |

**Recommendation: keep both languages, original wording, no translation.**

1. The production classifier prompt says "The request may be in any language";
   training must match the deployment distribution (about 60 % German).
2. The multilingual checkpoint (`laya-multilingual-mlx`) exists for exactly this.
3. Translating would destroy the cues that separate categories: a short
   colloquial continuation ("ok mach weiter") is `fallback` by production
   rule; its English rendering loses the register that makes it recognizable.

**Pitfall: language, length and category are confounded in our data.** Short
prompts are German and mostly trivial/simple/fallback; long prompts are
English pastes (reviewer prompts, logs, diffs) and mostly code_complex. A
model trained on this as-is can learn "German = cheap, English = expensive"
instead of the real signal. Rule for building the training / golden set:
balance per category AND per language, deliberately including English short
prompts and German long prompts even though sessions contain few; do not
draw the set purely from session history (curate it). Keep the ~60/40 mix as
the overall ratio so the set still mirrors real traffic. Caveats: one project's
sessions, one heuristic, prompts deduplicated (so frequent short German
continuations are under-represented relative to traffic).

## What the replay can and cannot say

**There is no ground truth yet.** The session backfill has no recorded
decision of the known classifier (the decision log, ADR-0027, started
2026-10-09), so "0 % agree" in the replay report is an artifact, not a
result. Quality numbers need either (a) decision-log records with
`store_text: "full"` collected over a few days, or (b) a labeled golden set.

## Observations (anecdotal where stated)

1. **The model sees only the `criteria` labels and the `instructions`
   string.** The first wrapper kept per-category descriptions in a dict that
   never reached the model — a spike-design trap worth remembering for any
   adapter.
2. **Prompt design moves the distribution a lot.** Same 383 prompts:
   - labels only (variant A): simple 167, code_simple 96, fallback 63,
     exploration 23, trivial 17, design 9, planning 7, standard 1, code_complex **0**;
   - descriptions in `instructions` (variant B): fallback 109, simple 88,
     trivial 60, exploration 59, code_simple 35, design 13, planning 10,
     standard 5, code_complex 4.
   Neither is "right" — without labels the shift cannot be scored.
3. **Confidence is high only on semantically distinct classes.** On 8 hand
   probes (anecdotal), design/planning/exploration reached 0.89–0.98 in
   variant B while the complexity axis (trivial/simple/code_simple/
   code_complex) stayed at 0.3–0.6. On the full corpus (variant B) only
   **9.4 %** of prompts reach confidence >= 0.8 (36 of 383; exploration 17,
   fallback 9, planning 5, trivial 2, design 2, standard 1); median
   confidence 0.42. The complexity axis is exactly what drives routing cost.
4. **Consequence for the integration design (hypothesis, not a result):**
   a confidence gate of 0.8 in front of the cloud chain would let Laya
   handle roughly a tenth of the traffic; whether those answers are correct
   is unmeasured. The 9 `fallback` answers at >= 0.8 deserve an eyeball
   (long inputs?).

## Context window / truncation budget (measured 2026-10-09)

**The model has a context window — this is a hard limit, not our choice.**
Truncation exists only so the combined input (instructions + 9 option labels +
context block + current request) never exceeds it. In practice the budget is
seldom hit: the prompt head consumes 408 tokens, and a 1,500-character real
prompt adds roughly 250–400 tokens.

**What we measured** (multilingual checkpoint, revision
`f2b4faf51023039425946074e2cf1361d2db11d5`):

- `encoder/config.json`: `model_type = ModernBertForMaskedLM`,
  `max_position_embeddings = 8192`, `local_attention (sliding window) = 128`,
  768 hidden size / 22 layers / 12 heads. The brief's "mmBERT-base, 322M,
  context 1024" is therefore only an approximation — the multilingual checkpoint
  is ModernBERT.
- `mlx_config.json` + `manifest.json`: HF revision `052592a15d...` of
  `convaiinnovations/laya-multilingual`, 643,835,426 bytes, weight SHA256
  `7fc5834af4d8fdfb268d272a9d1a66e5819a0daac98241651c4c888cc43adff1` (pinned).
- Empirical: inputs up to **~899 total tokens (head included) still answer**;
  architectural ceiling 8192.

**Conclusion for Task 3:** truncation budget = **1,024 tokens** (brief figure,
conservative; our head is 408, so we have ~600 tokens for prompt + context at
the median long-prompt length). The wrapper tokenizes exactly (it owns the
tokenizer), so truncation there is the single source of truth; the router
keeps a coarse character cap as an additional safety bound.

## Next measurements (need data, not code)

0. **Fine-tuning question (owner, 2026-10-09):** the upstream research brief
   (zero-shot ~0.36 vs 0.32 random, ECE 0.466 uncalibrated, fine-tuned ~0.767)
   and the observations above point the same way: the complexity axis
   needs training on our own labeled prompts. Not a decision yet — the
   integration plan defers fine-tuning until the golden-set benchmark gives
   numbers on our data. Prerequisite for either path: labeled prompts.
1. Let the decision log collect `store_text: "full"` records for a few days,
   then re-run `scripts/classifier-replay.ts --records ... --endpoint ...`:
   first real agreement rate, per-category confusion, agreement among the
   >= 0.8 subset.
2. Characterize truncation: prompts > 512 tokens, start vs end of State.
3. Prompt-design sweep (label vocabulary, instruction wording, multilingual
   prompts) scored against the golden set, not by eye.
4. Plan Task 0 steps 1-5 still open: upstream PyTorch `laya`, `laya-serve`,
   in-process ONNX numbers, and the process-management comparison
   (launchd / extension-spawned / manual).
