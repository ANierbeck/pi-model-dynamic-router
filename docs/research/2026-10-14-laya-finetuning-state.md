# Laya classification: state of the spike (2026-10-14)

A complete, self-contained account of the Laya fine-tuning strand — what was
built, what the numbers mean, and what the options are. Written to be re-read
later; no prior context required.

> **TL;DR** — The fine-tuning pipeline works end to end (data → teacher labels →
> training → MLX serving → parity → evaluation). The fine-tuned model is a huge
> improvement over zero-shot Laya (53.4 % vs 17.2 % group accuracy), but it
> lands **below its own teacher** (62.5 %) because the training signal is
> teacher-distilled, not owner truth. Every Go/No-Go threshold (85 % group
> accuracy, ≤ 5 % under-routing, gate ≥ 50 % coverage @ ≥ 92 % precision) was
> missed. The binding constraint is **label quality**, not model capacity: the
> model memorized the 85 owner-rated dev items to 96.5 %. Best remaining levers:
> a stronger teacher (Sonnet, measurable on dev), more owner labels, or both.

---

## 1. Why this strand exists

The router classifies every prompt into a category, maps the category to a
model group, and picks a model from that group. Classification is the single
most consequential decision in the pipeline. Today's production classifier is
a cloud LLM call; a local classifier would remove that dependency (offline,
zero marginal cost, ~30 ms instead of seconds). Laya
(`convaiinnovations/laya-multilingual`, 643 M parameters, MLX-served on Apple
Silicon) is the local candidate under test.

## 2. What the categories are (taxonomy v2)

Work in this strand replaced the old 9-category taxonomy with a 7-category one:

| Category | Meaning |
|---|---|
| `simple` | one-liner, no reasoning (greetings, factual snippets) |
| `code_simple` | tiny mechanical code change |
| `standard` | normal task, medium effort |
| `code_complex` | demanding coding: architecture, debugging, multi-file |
| `design` | API/architecture design deliberation |
| `planning` | task decomposition, step planning |
| `continue` | short continuation/confirmation that means "keep going" |

Two old categories were dropped after evidence: `trivial` and `exploration`
(owners rated identical texts inconsistently — noise, not signal). `continue`
was promoted from the old `fallback` bucket because a dedicated
continue-pass over 180 real items showed ~73 % of old-fallback traffic is
actually "keep going" **in context** (only recognizable with the previous user
message + last assistant snippet as background).

Planned GROUP mapping (continue → the tactical group, i.e. "the model that
was just answering"):

```
simple→operational  code_simple→simple  standard→operational
code_complex→tactical  design→planning  planning→planning  continue→tactical
```

**Important correction along the way:** an earlier claim that the evaluation
harness fed 400-char context windows was wrong — the corpus stores
prev/snippet already truncated to 150 chars (production: 120/150). Migration
must NOT widen the window; the validated prompt was validated with 150.

## 3. The validated prompt (v2-r3)

The classifier prompt was developed on the dev-85 split only; test-88 was
touched exactly once, after the prompt was frozen. Three rounds:

| Round | Change | dev category acc. | Verdict |
|---|---|---|---|
| r1 | continue = pure context-dependence | 100 % recall, but 43 % precision | every continuation claim looked plausible → no |
| r2 | + decision procedure, "in doubt → task" | 88.9 % precision, 33 % recall | too strict → no |
| r3 | + mechanical-execution clause | 54.1 % dev | frozen (rest = owner noise) |

Frozen prompt result on the untouched test-88 (the **teacher ceiling** for
`mistral/zai-glm-5-3` with the short-head serving constraint):

- category 53.4 %, **group 62.5 %** (always-tactical baseline 52.3 %, so +10.2 pp)
- under-routed 18.2 %, over 12.5 %, non-tactical recall 50 %, kappa 0.40
- by group: tactical 34/46, operational 14/21, planning 7/15, simple 0/6

Iteration was stopped deliberately: the continue-pass showed the owner rates
identical texts differently across sessions, so further prompt rounds would
fit noise. The prompt lives in `~/.laya-ft/prompts/v2-r3.json` (frozen).

## 4. Training data and run

- **Corpus**: 2019 train-split items (sessions corpus minus golden-set minus
  leaked items). Teacher (GLM, frozen v2-r3 prompt, short head 161 tokens —
  the production head is 387 tokens and does not fit Laya's ~1024-token
  window) labeled 2015/2019 ok.
- **Owner signal**: 85 owner-rated dev items, repeated ×3 (OWNER_REPEAT=3) →
  2270 training rows total. Golden test-88 was **never** in training; golden
  files are never committed (private).
- **Run r1** died at step 100 with MPS OOM: softmax over the full multilingual
  vocabulary scales with batch × seq-len × vocab; micro-batch 8 was too large.
- **Run r2** with `--micro-batch 2 --grad-accum 32` (effective batch 64 kept):
  3 epochs, loss 2.85 → 1.22, calibration fit on a held-out calibration slice:
  accuracy 22.9 % → 55.9 %, **ECE 0.39 → 0.086**, temperature **2.049**,
  abstention threshold 0.935 (choice, 6–10 options). `laya-train` wrote both
  into `rl_agent_config.json` — they ship with the checkpoint automatically.
- Note: the calibration metrics are in-sample for the calibration slice; the
  real test is the golden evaluation below.

## 5. Serving (no conversion step needed!)

A notable simplification: **the laya-train output directory serves directly.**
`laya_mlx.sanitize_weights` maps upstream PyTorch parameter names itself
(`act_head.0.* → act_head.layers.0.*`, `in_proj_bias → in_proj.bias`), both
checkpoints are float16, and `laya_mlx.load()` accepts a local path. The
sidecar (`spikes/laya-http/server.py`, laya-spike branch) gained:

- `--head-json <file>` — serve with the exact training head (train/serve
  parity; a different head measures prompt drift, not the model)
- `--model-dir <path>` — serve a fine-tuned checkpoint; without it the pinned
  HF snapshot `aac6fef/laya-multilingual-mlx@f2b4faf5` stays the model

**Argmax parity check** (PyTorch `laya` vs MLX `laya_mlx` on the same 22
items, same trained checkpoint): 22/22 identical argmax, max probability gap
0.0029 (fp16 rounding). The MLX path reproduces the trained model.

## 6. The Go/No-Go measurement (test-88, one touch)

Sidecar on port 8090 with `--model-dir runs/r2 --head-json laya_head_v2.json`
(production shadow sidecar on 8089 untouched):

| Metric | Laya fine-tuned r2 | Teacher (GLM) | Zero-shot Laya | Target |
|---|---|---|---|---|
| group accuracy | 53.4 % | 62.5 % | 17.2 % | ≥ 85 % |
| margin vs always-tactical | **+1.1 pp** | +10.2 pp | −19.4 pp | — |
| under-routed | 27.3 % | 18.2 % | 56.7 % | ≤ 5 % |
| non-tactical recall | 45 % | 50 % | 10 % | — |
| kappa | 0.28 | 0.40 | −0.05 | — |

Confidence gate curve (fraction of traffic Laya may answer locally, at the
precision it achieves there):

| gate | coverage | group precision | under-routed |
|---|---|---|---|
| ≥ 0.5 | 57 % | 66 % | 12 % |
| ≥ 0.6 | 36 % | 75 % | 6 % |
| ≥ 0.7 | **23 %** | **85 %** | 5 % |
| ≥ 0.9 | 2 % | 100 % | 0 % |

The gate target (≥ 50 % coverage @ ≥ 92 % precision) was **not** met; the best
operating point is ≥ 0.7 → 23 % of traffic at 85 % precision.

### What the numbers mean

1. **The distillation ceiling is real.** A student trained on a teacher's
   labels cannot beat that teacher; ours is 9 pp below. The teacher itself is
   only 62.5 % on group — no amount of training on GLM labels can push Laya
   past that.
2. **Capacity is not the problem.** On dev-85 (contaminated: those 85 owner
   items were ×3 in training) the model scores 96.5 % — it memorized the
   owner-labeled items nearly perfectly. The model can learn the mapping;
   there is simply not enough high-quality signal (2270 rows, of which 89 %
   from a 62.5 %-accurate teacher).
3. **ECE 0.086 is trustworthy in context:** confidence values are meaningful
   (the gate curve is monotone up to 0.9), which is exactly what a gated
   chain needs.

## 6b. Teacher check: Claude Opus 5.5 vs GLM (dev-85, 2026-10-14)

Question: is a stronger teacher worth the cost? Opus 5.5 labeled the 180
golden items with the frozen v2-r3 prompt (the labeler's `--split dev` flag
was not understood and labeled all 180; only dev items were scored here).

| Teacher (dev-85) | category | group | under | over | kappa |
|---|---|---|---|---|---|
| GLM 5.3 (train teacher) | 54.1 % | 68.2 % | 17.6 % | 10.6 % | 0.51 |
| Claude Opus 5.5 | 56.5 % | 64.7 % | 14.1 % | 15.3 % | 0.47 |

Paired: GLM correct on 6 items where Opus is wrong, Opus on 3 where GLM is
wrong (exact McNemar p = 0.51). Category labels agree on 65/85 items.

**Verdict: no measurable gain.** Opus is not a better teacher for this
taxonomy, so the training corpus stays on GLM labels. The owner-rating noise
seen in the continue pass likely caps any teacher at this level. Test-88 was
deliberately not scored for Opus, to keep the test split unused for teacher
selection.

## 7. Options going forward

| Option | Cost | Expected effect | Notes |
|---|---|---|---|
| **A. Sonnet as teacher** | ~180 dev calls to measure, ~1 h to re-label the corpus, ~35 min retrain | raises the ceiling from 62.5 % toward whatever Sonnet achieves on dev | measure first (`teacher_eval_v2.py`), decide after |
| **B. More owner labels** | ~20 s/item, 500 more items ≈ 3 h owner time | highest-precision signal available | the only signal above teacher quality |
| **C. More data** | rebuild corpus from recent sessions + re-label | more rows → better generalization | pairs with A or B |
| **D. Gated chain with r2 as-is** | integration work | 23 % of traffic at 85 % precision, 5 % under | below target but the router stays correct on the other 77 % |
| **E. Park Laya** | — | — | cloud classifier with the v2-r3 prompt gets ~62.5 % (teacher level) — still the best available classifier |

Honest expectation: even with a perfect teacher, Laya will not reach 85 %
group accuracy; the owner's own repeat ratings bound the truth. The realistic
end state for Laya is a **confidence-gated local first stage** — Laya answers
only when it is right, cloud confirms otherwise. Every improvement to the
teacher moves both the gate curve and the ceiling.

Independent of Laya's fate: the **production migration of the v2-r3 prompt**
(7 categories, `continue`, inherit-previous-category, `CATEGORY_TO_GROUP`) is
required so the router understands the taxonomy at all — and it lifts the
live cloud classifier from ~40 % (old prompt, old truth) toward the 62.5 %
teacher level. It is the highest-value next step either way.

## 8. File map

| Path | Content |
|---|---|
| `~/.laya-ft/prompts/v2-r3.json` | frozen classifier prompt candidate |
| `~/.laya-ft/to_laya_jsonl_v2.py` | training-data builder (short head 161 tok, OWNER_REPEAT=3, leak guards) |
| `~/.laya-ft/data/laya_head_v2.json` | the exact head Laya was trained and must be served with |
| `~/.laya-ft/data/train_v2.jsonl` | 2270 training rows (private, never committed) |
| `~/.laya-ft/data/golden.jsonl` | 180 owner-rated items, truth_v2, splits 85/88 (private) |
| `~/.laya-ft/golden_eval_v2.py` | sidecar vs truth_v2 evaluation (group mapping above) |
| `~/.laya-ft/teacher_eval_v2.py` | teacher labeling run vs truth_v2 |
| `~/.laya-ft/parity_check.py` + `/tmp/parity_torch.py` | PyTorch↔MLX argmax parity |
| `~/.laya-ft/runs/r2/` | the fine-tuned checkpoint (serves directly) |
| `spikes/laya-http/server.py` (laya-spike) | sidecar with `--head-json` / `--model-dir` |

Working commands:

```bash
# evaluate the fine-tuned model (sidecar already on :8090)
cd ~/.laya-ft && python3 golden_eval_v2.py --split test

# compare a teacher run against owner truth
python3 teacher_eval_v2.py data/<labels>.jsonl --split dev

# restart the eval sidecar if needed
nohup ~/.laya-sidecar/venv/bin/python \
  ~/git/pi-model-router-fork/spikes/laya-http/server.py \
  --port 8090 --model-dir ~/.laya-ft/runs/r2 \
  --head-json ~/.laya-ft/data/laya_head_v2.json &
```

## 9. Provenance

- Validation discipline: prompt iterated on dev-85 only; test-88 touched
  once (2026-10-14, run r2); further prompt iteration = noise fitting.
- Zero-shot reference numbers measured 2026-10-13/14 on the same golden set
  with the old taxonomy truth (`teacher 26.1 %/40 %`, `tfidf 22.8 %/32.8 %`,
  `laya zero-shot 3.9 %/17.2 %` category/group).
- Git: sidecar options committed on `laya-spike` (`--head-json` 5f6be02,
  `--model-dir` b6d8799); the alignment plan document stays untracked.
