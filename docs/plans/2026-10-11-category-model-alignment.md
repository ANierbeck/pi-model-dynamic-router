# Category–Model Alignment Implementation Plan

> **Status: SUPERSEDED 2026-10-25 — historical record, not maintained.**
> This file grew into several problems in one plan (AGENTS.md §11). It is
> committed for the first time on 2026-10-25; the content is as of
> 2026-10-14, except that owner prompt texts were replaced by paraphrases
> before the commit. Where each topic lives now:
>
> - Categories vs. groups (Phase 1.1/1.2 here — never implemented):
>   `docs/plans/2026-10-25-category-group-mismatch.md`.
> - Mid-tier ranking (1.4): decided 2026-10-12 (tactical `min_gdpval`
>   1630), merged in PR #67 — done.
> - Taxonomy v2, golden set, Laya fine-tuning (Phase 2, 3b, 3c-pre2):
>   `docs/research/2026-10-14-laya-finetuning-state.md`; production
>   migration merged in PR #70.
> - The overloaded word "fallback": its own plan
>   (`docs/plans/2026-10-25-fallback-naming.md`).
>
> Known errors in the text below (left as written):
>
> - The header says "Proposed — awaiting owner approval"; most of it was
>   decided and partly merged.
> - 1.4 is headed "BLOCKED" and "Owner decision 2" says "OPEN"; both were
>   decided on 2026-10-12.
> - The continue-pass section says "group mapping continue → fallback
>   group"; the code and PR #70 map `continue` → `tactical`.
> - The 1.1 table lists the retired categories `trivial`, `exploration`
>   and `fallback`.

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Status:** Proposed — awaiting owner approval. No code changes until the
owner approves this plan.

**Relationship to prior plans:** Extends the approved ADR-0024 /
`docs/plans/2026-10-05-task-type-balancing.md` direction (owner decision
2026-10-05: task-type split, top tier only for demanding work, neutral
repo defaults, personal values in `router-config.user.json`). Phase 2
(fallback inherits the previous category) and Phase 3 (configurable
`category_groups`) of that plan are already implemented; this plan adds
what it could not see: live evidence that below design/planning the free
tail serves almost every category, plus the 1:1 category→group rename and
the taxonomy work.

**Goal:** Each classification category routes to a group whose *effective*
model pool matches the task type — cheap pools for trivial/one-shot work,
quality-ranked pools for multi-step and hard-code work, top tier for
design/planning. Category names and group names become 1:1 identical so
the mapping is not a footgun. The taxonomy itself (the 9 categories) is
revised in a second phase, grounded in the owner's 180-item golden rating
currently in progress.

**Architecture:** Task 0 verifies the score data. Phase 1 is the
alignment (renames with alias compatibility, 1:1 `CATEGORY_TO_GROUP`
with its behaviour changes made explicit, and a mid-tier ranking rule
that is chosen only after an offline simulation). Phase 2 is the taxonomy
revision, explicitly gated on the golden-set evaluation. Phase 3 is
verification and rollout.

**Tech Stack:** `content-classifier.ts` (`CATEGORY_TO_GROUP`),
`routing.ts` (group resolution, alias map, sort modes), `config-loader.ts`
(group schema), shipped `router-config.json`, vitest.

---

## Evidence (2026-10-11, re-verified against the code and the raw log)

**Method note (correction).** The first draft counted the
`[routing] group=<g> method=… candidates:` log lines as "decisions". They
are not: the router logs one such line for EVERY group on each prompt (a
12-line sweep, ~60 ms apart) — it shows how each group *would* rank, not
what was chosen. The real selection is the `<category> → <group> <model>`
line, and the real load is the `[stream]` lines. Numbers below come from
those two (`router.log`, since 2026-10-09; selection sample is small,
**n = 96**, so read the shape, not the decimals).

Real selections (category → chosen model):

| category | n | chosen |
|---|---|---|
| exploration | 20 | ling-3.1-flash 13, apodex-1.1-mini:free 7 |
| standard | 16 | ling 13, apodex 3 |
| planning | 12 | claude-sonnet-5-5 12 |
| code_complex | 11 | ling 10, claude-haiku-5-5 1 |
| fallback | 11 | ling 8, haiku 2, apodex 1 |
| design | 8 | claude-sonnet-5-5 8 |
| code_simple | 5 | ling 3, apodex 2 |
| trivial | 2 | apodex 1, ling 1 |

Real stream load by model (all streams, incl. tool-loop steps): apodex-1.1-mini:free
64%, claude-sonnet-5-5 14%, zai-glm-5-3 12%, haiku-5-5 4%, opus-5-5 2%,
ling-3.1-flash 2%, north-mini-code:free 1%. ling is flagged `[limited]`
(free cap exhausted) in 356 sweep lines, so the free tail — apodex
(gdpval 1190), a model that passes every `min_gdpval` floor ≤ 1190 — carries
most of the real traffic.

Findings:

1. **Separation exists only at the top.** design/planning → sonnet-5-5
   (12/12 and 8/8, the `min_gdpval 1700` floor works). Everything below —
   standard, code_complex, fallback, exploration — is served almost
   entirely by free models. That confirms the owner's impression; the
   mid tier has no pool of its own.
2. **code_complex landing on a free model is ADR-0023 working as
   designed, not a mystery.** `tactical` is method `best` with
   `best_quality_window: 0.05` (`router-config.json:10`,
   `src/routing.ts:680`): every candidate within 5% of the best score is
   "equally good" and the cheapest wins. ling (1618) is 2% below GLM
   (1651), so it wins by rule. The first draft called this unexplained.
3. **Tiered groups rank billing tier first** (free → subscription →
   local → payg; gdpval only breaks ties, `src/routing.ts:726`), and
   `min_gdpval` is a floor, not a task selector.
4. **Naming/mapping footguns (verified against `CATEGORY_TO_GROUP`):**
   category `trivial` → group **`scout`** (the group named `trivial` is
   unreachable from any category); `simple` → `operational`;
   `standard` → `operational` (the group named `standard` is unreachable);
   `code_simple` → `simple`; `fallback` → `tactical`. Unreachable from
   categories: `trivial`, `standard`, `complex`, `strategic`.
5. **Already implemented, NOT part of this plan's work:**
   `fallback` inheriting the previous category
   (`inheritPreviousCategory`, `src/content-classifier.ts:577`, trace
   step `fallback-inherit`, ADR-0024 Phase 2) and the user-layer
   `category_groups` override (`src/config-loader.ts:157`, ADR-0024
   Phase 3). The first draft listed both as new work.
6. **Unverified precondition — can the gdpval numbers be trusted?** The
   scan cache holds `ling-3-1-flash: 1617.9` (≈ haiku-5-5 at 1618.07), so
   a free flash model outranks `mistral-large-4` (1422). The key exists;
   what has NOT been checked is that this benchmark row really is the
   OpenRouter model of that name (identity matching is the OD7
   workstream). The first draft stated "not an identity bug" — that was
   an assertion without a check. If the score is inflated, the whole
   mid-tier picture is a data defect, not a ranking-rule defect. See
   Task 0 below.

## Owner decisions (2026-10-11)

1. **Staged scope:** Phase 1 aligns mapping/groups mechanically now;
   Phase 2 reworks the category taxonomy only after the 180-item golden
   rating delivers empirical per-category agreement data.
2. **Mid-tier principle — OPEN, needs a fresh owner decision.** The
   option the owner picked on 2026-10-11 ("quality-gap rule: the better
   model wins inside the cost cap unless the gap to the free candidate is
   small, e.g. < 5-10% gdpval") is internally inconsistent with the
   example attached to it: GLM (1651) vs ling (1618) is a ~2% gap, which
   the rule itself would resolve in favor of the free model — i.e. no
   change, and exactly what `best_quality_window: 0.05` already does for
   `tactical`. The draft's `rank_by: gdpval` (pure gdpval order, window
   dropped) is a *different* rule and was not what the owner chose. Phase
   1.4 is therefore blocked until the owner re-decides with simulated
   outcomes in hand (see 1.4).
3. **Naming:** category name == group name, 1:1, with legacy names kept
   as aliases so existing hints/configs keep resolving.

---

## Phase 1 — Alignment (mechanical)

### 1.1 Group rename with alias resolution

Canonical group names become the category names. Legacy names resolve
via a static alias map at every entry point (`detectGroup`, hint parsing
`hint:group:<name>`, `model_groups` keys, `fallback_groups` chains,
classifier replay):

| legacy group | canonical | alias kept? | semantics |
|---|---|---|---|
| trivial | `trivial` | — | free-first (`local_before_payg`), min_gdpval 0. NOTE: category trivial currently maps to `scout`, not to this group — see behaviour changes |
| simple (free coding) | `code_simple` | no `simple` alias (collision) | free coding models, max_cost 0 |
| operational | `simple` | yes: `operational` | cheap one-shot, free-first |
| standard | `standard` | — | multi-step; floor 500 / cap 5.0 (see behaviour changes). Ranking rule pending decision 2 |
| tactical | `code_complex` | yes: `tactical` | method `best` + 5% quality window (ADR-0023), max_gdpval 1700 cap kept (top tier stays reserved) |
| planning | `planning` | — | top tier, min_gdpval 1700 (design + planning share this pool — documented, 2:1) |
| scout | `exploration` | yes: `scout` | open-ended search, free-first |
| fallback | `fallback` | — | true-unknown pool (see 1.3) |
| complex, strategic | unchanged | — | hint-only groups, documented as non-category groups |
| dynamic, bulk_reader, code_writer | unchanged | — | context-based, not category groups |

**Behaviour changes hidden in a "pure rename" (must be decided, tested,
and listed in the CHANGELOG — a 1:1 mapping is NOT behaviour-neutral):**

- category `trivial`: `scout` (cloud_first, free tail) → group `trivial`
  (`local_before_payg`: local Ollama ahead of payg). Different tier order
  for the cheapest prompts.
- category `standard`: `operational` (floor 300, cap 2.0) → group
  `standard` (floor 500, cap 5.0, different fallback chain). Higher floor
  AND a 2.5× higher cost cap for every standard prompt.
- category `simple`: same pool as today (`operational` renamed `simple`).
- category `fallback`: `tactical` → group `fallback` (free-only,
  `max_cost 0`). With inheritance already in place this only affects
  prompts with no history; confirm with a test, do not assume.

Each row needs an explicit owner nod or a config that keeps today's
numbers.

**Collision handling:** the name `simple` is the only ambiguous one. It
becomes the canonical name of the *category-simple* pool (ex-operational);
the old `simple` group is renamed to `code_simple` and does NOT get a
`simple` alias. Any config still saying `simple` now resolves to the new
category-aligned group. This is a one-time, documented change
(CHANGELOG entry + migration note); every other legacy name keeps working
through its alias.

### 1.2 `CATEGORY_TO_GROUP` becomes 1:1

`trivial→trivial, simple→simple, code_simple→code_simple,
standard→standard, code_complex→code_complex, design→planning,
planning→planning, exploration→exploration, fallback→fallback`.
The mapping stays overridable via the user layer (2026-10-05 plan
Phase 3, `category_groups` config key) so owners can re-point a category
without code changes.

### 1.3 Fallback inheritance — ALREADY IMPLEMENTED (no work)

`inheritPreviousCategory` (`src/content-classifier.ts:577`, ADR-0024
Phase 2) already makes a `fallback` classification inherit the previous
turn's category; fresh sessions keep the default. Remaining work here is
only (a) a regression test that the `continue` rename (Phase 2) keeps the
inheritance path intact, and (b) the optional decision whether the
`fallback` *group* (no-history prompts only) should keep `max_cost: 0`.
The earlier proposal to raise it to `min_gdpval: 300` is dropped until
the behaviour-change list in 1.1 is decided.

### 1.4 Mid-tier ranking — BLOCKED on owner decision 2; simulation performed

The simulation was run by the delegate agent (`claude-bridge/claude-opus-5-5`,
offline, read-only), 2026-10-12, and written to
`/tmp/catplan/sim-report-A-D.md`. The replica reproduces today's real
routing with **845/845** sweep rank-1 matches and **97/97** prompt-level
matches, so the outcomes below are reliable for today's score state.

Key facts:
- **F1** `mistral/zai-glm-5-3` already ranks in the **free tier (tier 0)**:
  `isFreeModelRef` accepts the scan placeholder `cost_per_m: 0`, so GLM
  competes with the free models in tiered groups whenever it is not
  `[paced]` — this is why it already wins 20-24% of standard/complex sweeps
  today. The placeholder is disputed in the code (`liveGroupFilterLookups.isFree`
  states it must not make a model free).
- **F2** `score_by: coding` / `briefcase` currently score exactly gdpval.
- **F3** Scores moved between 10-09 (ling 1621.75) and 10-10 (ling 1617.9):
  a fixed floor near the free tail lands on different sides of ling
  depending on the day.
- **F4** Most stream load comes from in-turn failovers (mid-turn 429s
  ling→apodex→gemmas→…→GLM).

Outcomes (n = 97 prompts):

| rule | changes vs A | who wins mid-tier (standard / code_complex / fallback) | quota shift: free→claude→mistral |
|---|---|---|---|
| A status quo | — | free tail (ling) | 72 / 28 / 0 |
| B extend 5% window to tiered groups | 16/97, all **category standard → sonnet-5-5** (16/16) | standard: sonnet-5-5; code_complex/fallback unchanged (free tail) | 47 / 53 / 0 |
| C-lo `min_gdpval` 1200 | 4/97, only when ling is `[limited]`/`[unhealthy]` | standard: haiku-5-5 / GLM fallback; code_complex/fallback unchanged | 69 / 28 / 3 |
| C-hi `min_gdpval` 1619 | 22/97 (standard 10, fallback 9, code_complex 3) | standard: sonnet-5-5 (56%); code_complex: GLM-5-3 (27%); fallback: GLM-5-3 (82%) | 53 / 38 / 9 |
| D pure gdpval (cost tiebreaker only) | 45/97 rank-1 changes | standard → opus-5-5; code_complex → GLM-5-3 (62%); fallback → GLM-5-3 (55%); planning/design → opus | 43 / 53 / 4 |

Notes:
- B's quota shift (claude-bridge 28% → 53%) comes from `operational`, which
  has no `max_gdpval`: opus (1900) and sonnet (1838) form the 5% window and
  sonnet is cheaper. `tactical` already has the window, so code_complex does
  not change — my earlier "no visible change" expectation was wrong for
  `operational`.
- D does not automatically inflate the bill: GLM is already in the free
  tier (F1), so its rise to code_complex/fallback is free; the claude-bridge
  increase under D is opus-5-5 instead of sonnet-5-5.
- Equivalences at the winner level: **A ≡ B** except category standard;
  **A ≡ C-lo** except 4% of prompts when ling is unavailable.

**DECIDED 2026-10-12 (owner): C-tactical ~1630.** The floor applies only
to the `tactical` group (serves code_complex + the no-history fallback
category), tuned to 1630 — above every observed ling value (1617.9 /
1621.75, simulation F3 drift) and below every observed glm-5-3 value
(1650.73 / 1652.93). Expected effect: GLM wins tactical ~100% (it is the
only candidate in [1630, 1700]); when exhausted/unhealthy, tactical falls
through to strategic (sonnet), never back to the free tail. Standard /
simple / trivial / exploration keep the free tail; design / planning keep
the strategic window. The floor is a quality gate, not a vendor gate (any
model ≥ 1630 stays admissible — ADR-0025 derivation). MERGED 2026-10-12: PR #67 (floor
+ red-first pins: config, pool filter, non-vacuous sortBy) and PR #66
(the identity defects that grounded the decision — labelKey discipline,
variant-token veto, qwen builtin removal, provenance). The floor must be
re-checked whenever ling or glm drifts across it, and replayed against a
wider log window before release (F3: scores move).

### 1.5 Config, tests, docs

- Shipped `router-config.json`: rename groups, apply the 1.4 decision,
  update all `fallback_groups` chains to canonical names (aliases still
  resolve, but the shipped file leads by example).
- Red-first tests per AGENTS §4: alias resolution (each legacy name →
  canonical pool), collision behavior of `simple`, one pin per row of the
  behaviour-change list in 1.1, the chosen ranking rule from 1.4 (both
  sides), `fallback-inherit` still firing after the `continue` rename,
  1:1 mapping pin.
- Update `docs/routing-flow.md`, `README`, `CHANGELOG`.
- `npx tsc --noEmit`, full suite green, coverage thresholds unchanged.

## Task 0 — Verify the score data (DONE 2026-10-12)

Outcome: `ling-3-1-flash: 1617.9` is **CONFIRMED** (a real Artificial
Analysis GDPval row for inclusionAI's Ling 3.1 Flash: exact slug hit,
labelKey twin agrees, no variant overwrite). The "mid tier has no pool"
finding is a genuine ranking-rule problem, not a data defect. The actual
identity defects are different (report:
`/tmp/catplan/task0-identity-report.md`):

- **apodex-1.1-mini:free** scores 1190.82 inherited from the full
  `apodex-1-1` model — the fuzzy matcher ignores `mini`. The OD7 audit
  flags exactly this case as a defect (identityCompatible = false).
  Action: add it to the OD7 identity-fix queue (scraper must persist
  `creator`/`displayName`; fuzzy match must respect discriminating
  variant tokens); red-first tests.
- **qwen3.8-27b** is under-scored (curated `gdpval_builtin: 580` shadows
  AA rows at 1071-1381; also mis-scores the OpenRouter API twin). Action:
  re-derive or remove the value per ADR-0025 Phase E.
- Systemic scraper defect: labelKey is dot-less and paren-stripped, so AA
  family variants (`(low)`, `(Preview)`, `-mlx`) collide and the lowest
  variant's score wins (`command-a` gets the A+ score, `mistral-large-4`
  the Preview row, `gpt-6-astra` the low variant). Dotted slugs
  (ling-3-1-flash, claude-haiku-5-5, glm-5-3) are immune.

Phase 1.4 proceeds on the simulation above; the identity fixes are
independent OD7 work.

## Golden-set evaluation (2026-10-11, owner ratings, n = 180)

Teacher = GLM (zai-glm-5-3, single teacher; 20 items also have Sonnet and
large-4), reference = the owner's ratings, made blind to the teacher
labels. The set is **enriched**, not a traffic sample (minority classes
oversampled), so absolute accuracies are not traffic-weighted.

- Category accuracy 47/180 = 26.1%; GROUP accuracy 72/180 = 40.0%
  (Wilson 95% [33%, 47%]), kappa 0.18; the "always operational" baseline
  is 36.7% → margin +3.3 pp; under-routed 27.8%, over-routed 29.4%.
  No Go/No-Go threshold is met.
- Excluding GLM's `fallback` items (67): category 33.6%, group 40.7%
  (Wilson [32%, 50%]) — the fallback label is NOT the whole problem.
- Exact-category hit rate by GLM class: trivial 0/24, exploration 0/2,
  simple 1/7, code_simple 2/12, standard 4/8, design 4/9, planning 4/8,
  code_complex 23/43, fallback 9/67 (the owner chose `fallback` 11
  times; GLM agreed on 9).
- What GLM's `fallback` items look like: median 10 words; 18/67 have ≤ 5
  words, 18/67 have ≥ 20 words. Only the short ones are plausibly pure
  continuations; the long ones are full instructions. Owner re-labeled
  them 25 standard, 17 code_complex, 9 code_simple, 4 design, 2 simple,
  1 planning, 9 fallback.
- GLM's `trivial` items are NOT acknowledgments (examples: find a thread,
  show the current todo.md, run a whoami command — owner prompt texts
  removed before commit): GLM applies `trivial` to
  short real tasks. The owner never used `trivial` or `exploration`;
  the set contains almost no pure "ok/yes" prompts, so `trivial`-as-
  defined cannot be judged from it.

**Open hypothesis, NOT a result:** the owner expects ~4/5 of the items
rated `standard`/`code_complex` to be continuations ("continue"), maybe
90% of them. Not measured. Caveat: the rating tool showed `prev`
truncated to 150 characters, so continuation judgements were made on
partial context. Plan: a short owner pass over those items with full
previous-turn context, marking "continuation yes/no", before any
taxonomy decision is based on the claim.

**Conclusion that is supported:** GLM consensus does not reproduce the
owner's judgement (+3.3 pp over a constant) and must not be the sole
training signal. Whether the `continue` rename fixes much of it is
unmeasured.

## Continue-pass results (2026-10-13, owner-rated)

**Owner decisions 2026-10-13 (Phase 2 taxonomy freeze):**
- `trivial` is DROPPED — short real tasks classify as `simple` (group scout,
  stays cheap). GLM never used it correctly (24 items, 0 correct); the owner
  never used it in 180 ratings.
- `exploration` is DROPPED (2 items, 0 correct, never owner-rated).
- New category set (7): standard, code_complex, code_simple, design,
  planning, simple, continue (renamed from fallback; group mapping
  continue → fallback group).


All 67 consensus-fallback items rated with full prev context (`continue_ok` in
`golden.jsonl`; owner_cat untouched):

- **49 yes / 17 no / 1 unsure = 73.1 % true continuations** — the
  fallback → continue rename is CONFIRMED for the majority.
- The 17 "no" items are real conversational turns GLM misrouted as fallback:
  corrections ("that was not an instruction"), meta-instructions
  ("remember this in memory") — paraphrased, owner prompt texts removed
  before commit —, questions, new design discussions.
  Owner categories: code_complex 7, fallback 5, design 3, standard 2,
  planning 1 — with a precise continue definition these should classify as
  their real task categories.
- **Context dependence is the key design fact**: the SAME prompt text
  (a correction telling the agent to stop investigating an HTTP 503;
  text removed before commit) appears in two
  sessions, rated `no` in one and `yes` in the other. Continue/no-continue
  is NOT decidable from the prompt text alone — the classifier must see the
  previous message (the corpus provides it; the memory-block fix feeds it).
- Length is a weak signal only: short (≤5 words) 15/18 yes, but long
  (≥20 words) still 10/18 yes — long status-report continuations exist.
- The 1 unsure item (a "supposedly we were done" remark; text removed
  before commit) stays excluded from
  continue-accuracy denominators.

Implication for the prompt revision:

**Validation harness ready (2026-10-13):** the production repo stays
UNTOUCHED until the draft passes validation (the migration blast radius is
24+ test files pinning the old categories — premature migration would ship
an unvalidated taxonomy). Instead:
- `golden.jsonl` carries `truth_v2` + a stratified `dev`/`test` split
  (88/92; eval-eligible 173 — 85 dev / 88 test; 7 ambiguous excluded:
  5 owner-fallback-not-continue + 2 owner-fallback-unmeasured).
- `~/.laya-ft/data/corpus_golden.jsonl` — the 180 golden items as a
  labeler corpus.
- `~/.laya-ft/prompts/v2-r1.json` — prompt draft (7 categories, continue
  definition from the continue-pass findings, context window prev/snip
  400/400 — the continue-pass showed 120/150 chars are too little for
  continuation judgment).
- The laya-labeler extension gained `--prompt <file>` (prompt-surface
  override in classifier-replay: template + categories + context window);
  draft labels never mix into production label files (pair with --out).
- Eval: `python3 ~/.laya-ft/eval_v2.py <labels> --split dev|test`.

Validation loop (per the dev/test discipline): run the teacher (GLM) on
corpus_golden with the draft → iterate the draft on dev-85 → single final
measure on test-88.

**Validation RESULT (2026-10-13, teacher = mistral/zai-glm-5-3):** three
draft rounds, all 180/180 ok. r1: continue recall 100 % but precision 43 %
("meaning depends on context" clause swallowed task categories). r2
(decision procedure, in-doubt→task): precision 88.9 % but continue recall
33 %. r3 (mechanical-execution-of-current-act clause): balanced. FINAL
test-88, prompt frozen before the run: **overall 53.4 %** (dev 54.1 % —
no overfit gap), continue recall 76 % / precision 76 %, code_complex 57 %,
simple 100 %, planning 50 %, design 27 %, code_simple 0 % (n=6),
standard 37.5 %. Remaining errors are noise-dominated: the continue-pass
itself showed the owner rates identical texts differently in different
sessions; the residual misses (standard↔simple, plan-update-in-flow,
memory-command corrections) are judgment calls, not systematic prompt
defects. Further prompt iterations would fit noise, not signal.

**CORRECTION (2026-10-13, same evening): the 400/400 claim above was
wrong.** The corpus stores `prev`/`snip` already truncated to 150
characters (`build_corpus.py`), so the draft override's 400/400 window had
NO effect: the labeler saw at most 150/150 characters of context — the
same window Laya and (almost) production see (production slices 120/150).
The validated prompt is therefore validated for the EXISTING window; the
migration does NOT have to raise it, and raising it would be an
unvalidated change. Consequence worth knowing: the owner's continue-pass
used `--full` context while the labeler saw 150 characters, which
plausibly caps continue recall (76 %) — a candidate for a later
experiment (corpus rebuilt with longer prev), not a migration blocker.

**Teacher quality at GROUP level (v2-r3 vs truth_v2, continue→tactical
group):** dev 68.2 %, test 62.5 % (n=88; majority baseline 52.3 %),
under-routing 18 %, over-routing 12.5 %, non-tactical recall 50 %. A
student distilled from this teacher cannot be expected to beat it, so the
proposed Go/No-Go (group ≥ 85 %, under ≤ 5 %) is out of reach for pure
distillation; the thresholds were always flagged "owner to confirm" and
must be re-confirmed after the taxonomy freeze (3b). The realistic
use of Laya is the confidence-gated chain (answer only when confident,
else defer to the cloud classifier) — the gate criterion (≥ 50 % coverage
at ≥ 92 % precision) is the one to watch.

**Laya head constraint:** Laya's window is ~1024 tokens; the old head is
~390 tokens, the v2-r3 labeler body is 902 tokens and cannot be the Laya
head. Training and serving use a SHORT head (161 tokens,
`to_laya_jsonl_v2.py::SHORT_INSTRUCTIONS`, exported to
`data/laya_head_v2.json`; the sidecar serves it via `--head-json`). The
long prompt's knowledge reaches Laya through the labels only.
 Only after that: the production migration round
(content-classifier category set, CATEGORY_TO_GROUP, inherit logic, 24+
test files, all red-first) + full-corpus re-label (~1 h GLM).
 `continue` = the prompt is not a
self-contained task and only makes sense as a continuation/correction/
extension of the previous exchange; anything that opens a new act
(question, instruction, memory command, new topic) is a task category,
never `continue`.

## Phase 2 — Taxonomy revision (gated on the golden rating)

Prerequisite: the owner finishes rating the 180-item golden set and
`golden_eval.py` produces per-category agreement (GLM vs owner), the
TF-IDF floor, and the owner's notes on where the category boundaries felt
wrong (trivial vs simple, code_simple vs simple, exploration vs trivial).

Candidate changes to evaluate against that data — not to implement
blindly:

- `fallback` as a category name (see below) — confirmed rename to `continue`;
- **trivial/exploration unused by the owner** (24x/2x GLM-only labels):
  redefine (e.g., trivial = pure acknowledgments "ok/ja/thanks", no task),
  merge boundaries, or drop — decision needs the owner's view on the 24
  GLM-trivial prompts ("index.ts", "todo.md", "4.000 Zeilen");
- sharpen trivial/simple boundary (acknowledgment vs one-shot factual,
  noun-phrase hints like "index.ts");
- sharpen code_simple/standard boundary (few lines vs multi-step procedure);
- resolve code_complex vs design vs planning (architecture vs roadmap vs
  hard code — fuzzy in ~40% of code_complex items);
- `continue` handling in the prompt: teach the labeler to detect context
  continuations ("ok then finish…", "rebase on main") and emit `continue`
  instead of a content-based mislabel — the classifier learns continuation
  detection, routing inherits lastCategory;
- collect owner notes via `golden_label.py` `n` per item to guide each
  boundary decision.

**Recommended rename: category `fallback` → `continue`.** The term
`fallback` is misleading and overlaps semantically with the genuinely
misbehaving `fallback → tactical` path: the category is defined as
"continuation of the current workflow where any of the above could apply"
— it means "we continue the same task in the same context", not "fallback
to a model". Meanwhile the *group* `fallback` is correctly named (it is
used when no history exists at all — a genuine model fallback). Category
and group should therefore diverge in name: `continue → fallback`.
This rename is safe on its own (it only touches the classifier prompt,
`CATEGORY_TO_GROUP`, and re-labeling — all of Phase 2 anyway), so it is
flagged as a recommendation rather than an open question, and we will
confirm it against the owner's notes during the ratings.

**Precondition for re-labeling:** the revised `classification-prompt.ts`
must first be validated against the 180 owner-rated items as a **holdout
set** — only after GLM (new prompt) agrees with the owner at a reasonable
level do we re-label the full corpus (~1 h).

Deliverable: a revised `classification-prompt.ts` category list + a
re-labeling run (single-teacher GLM, ~1 h) + re-evaluation against the
owner's golden ratings. **Sequencing with the Laya fine-tuning: the
taxonomy must be frozen before fine-tuning starts** — training on a
taxonomy that phase 2 then changes would invalidate the labels. The
fine-tuning go/no-go therefore waits for phase 2's outcome (or an
explicit owner decision to freeze the current 9 categories).

## Phase 3 — Verification & rollout

### 3a. Alignment (Weg A / Phase 1 mechanics)
- Replay the decision log (`classifier-replay` extension) with the new
  1:1 mapping and aliases; compare model distribution before/after — the
  expected shape: trivial/simple/exploration on free models, standard/
  code_complex on the quality-ranked mid pool, design/planning on the top
  tier, and *no* group where a free model wins every tier.
- Shadow stats for a few live days; check quota burn on both subscriptions.

### 3b. Ground-truth path (Weg B, owner-approved 2026-10-11)

Two constraints the first draft violated:

1. **No train/test leakage.** The 180 ratings cannot be both the training
   signal and the holdout. Split them first, stratified: ~90 *dev* (used to
   tune the labeler prompt and to weight/train) and ~90 *test* (touched
   once, at the end). Prompt iteration on all 180 would leak just as much
   as training on them; if the dev half proves too small, rate a fresh
   blind batch instead of reusing test items.
2. **The ratings belong to the old taxonomy.** After `fallback → continue`
   or any boundary change, items whose category changed meaning must be
   re-rated (the "continuation yes/no" pass above is the natural first
   step) before they count as ground truth again. Go/No-Go thresholds
   were set for the 9-category/6-group layout and are re-confirmed after
   the taxonomy is frozen.

Steps:

- Revise the labeler prompt; measure GLM-with-new-prompt vs the owner on
  the dev half only; iterate.
- Re-label the corpus with the accepted prompt (single teacher, ~1 h).
- Train Laya on the re-labeled corpus, with the owner's dev ratings as
  the highest-weight examples; never GLM labels alone.
- Evaluate once on the untouched test half with `golden_eval.py`;
  Go/No-Go is decided on those numbers.
- MLX conversion + argmax-parity check; only then switch the sidecar.

### 3b RESULT (2026-10-14, fine-tune run r2, owner go/no-go pending)

Pipeline proven end to end: re-label of the train corpus with the frozen
v2-r3 prompt (2015/2019 ok), training on 2270 rows (2015 GLM one-hot +
85 owner-dev x3) on MPS (micro-batch 2 after the batch-8 OOM), MLX serving
directly from the laya-train output (laya_mlx sanitizes PyTorch names
itself; no conversion step needed), argmax parity 22/22 items, max prob
gap 0.0029. Temperature calibration (2.049) and the 0.935 abstention
threshold were written by laya-train into the checkpoint.

TEST-88 (touched once, clean — never in training):
- group accuracy 53.4 % (teacher 62.5 %, always-tactical 52.3 %; margin
  +1.1 pp vs teacher +10.2 pp), under-routed 27.3 %, non-tactical recall
  45 %, kappa 0.28.
- Confidence gate: >=0.7 -> 23 % coverage @ 85 % precision, 5 % under;
  >=0.9 -> 2 % coverage @ 100 %. Target (>=50 % @ >=92 %) NOT met.
- Zero-shot Laya for scale: 17.2 % group — the fine-tune is a massive
  improvement over zero-shot but below the teacher.
- Dev-85 (contaminated: owner items x3 in training): 96.5 % — the model
  memorized the owner items; capacity is fine, the binding constraint is
  signal quality (teacher 62.5 %) and volume (2270 rows).

Verdict (owner to confirm): NO-GO for standalone and for the gated chain
at r2 quality. Best next lever is NOT more Laya training but the
production migration of the v2-r3 prompt (lifts the live cloud classifier
from ~40 % to ~62.5 % teacher level). Revisit Laya with a stronger
teacher signal (Sonnet as single teacher, or more owner labels) later.

### 3c-pre. PRODUCTION MIGRATION LANDED (PR #70, merged 2026-10-14, main=6f4ac08)

The v2-r3 prompt (frozen candidate, byte-identical to
`~/.laya-ft/prompts/v2-r3.json`), the 7-category set, `CATEGORY_TO_GROUP`
(continue→tactical, simple→scout — the other five unchanged, per the
2026-10-13 freeze), the `continue`-keyed `inheritPreviousCategory`, and the
static/probe/replay alignment are on `main`. Red-first: 11 taxonomy pins
observed red pre-migration; suite 2084 passed / 3 skipped post-review-fixes;
coverage thresholds unchanged; build green.

Sourcery review round (all 6 findings resolved before merge): 4 verified
defects fixed (probe-cache signature `classifier_fallback_probe_sig` — a
taxonomy change now invalidates the persisted fallback probe cache;
session-scoped lastClassifiedCategory — `resetLastCategory()` on
session_shutdown; replay agreement no longer counts invalid/legacy labels;
replay KNOWN_CATEGORIES derives from VALID_CATEGORIES), 2 justified as
not-a-defect (short-prompt momentum is a validated feature; replay diff
against historical labels IS the migration metric).

Owner decision recorded 2026-10-14 (evening): `openrouter/cohere/north-mini-code:free`
excluded in the USER layer (`router-config.user.json` exclude.models) — the
owner judged its outputs unusable for real work; repo defaults stay neutral
per ADR-0025 §2(C).

NOTE for the live router: the running pi process still loads the old
build (main checkout on laya-spike). The new taxonomy reaches production
when the laya-spike branch merges/rebases onto this main and the checkout
rebuilds.

### 3c-pre2. Laya spike aligned with v2-r3 (laya-spike 60d60f4+04a1918, pushed 2026-10-14)

`origin/main` (PR #70) merged INTO laya-spike (no history rewrite — the 15
remote spike commits stay pushable; a true rebase would have force-pushed
published history without owner approval). Root cause of the 32 red Laya
tests: `buildClassifierLayaQuestion` derived the question head by slicing
`CLASSIFICATION_PROMPT` — parity only while the old prompt body WAS the head.
The v2-r3 decision procedure (~1000 tokens) does not fit Laya's window and
zeroed the prompt budget. Fix: the head is the FROZEN short artifact
(`LAYA_HEAD_V2_INSTRUCTIONS`, 687 chars/161 tokens, verified byte-identical
to the training/serving head `laya_head_v2.json`); the spike server's
zero-shot path reads the same frozen head from the TS source; `--head-json`
stays authoritative for fine-tuned checkpoints. `vetAnswer` drops the dead
`fallback` special case (v2: outside the taxonomy, generic check covers it).

Shadow sidecar restarted on 8089 serving run r2 with the trained head
(byte-parity with the eval sidecar on 8090 confirmed via identical
/classify answers). The sidecar-manager extension now spawns r2
(--model-dir/--head-json) instead of the zero-shot base model.
`dist` rebuilt; the new taxonomy goes live on the next pi restart.

### 3c. Release gating
- Standard §1 release flow: clean code review (pi-superpowers `requesting-
  code-review`), owner approval for the release itself; the alignment is
  small and self-contained so it can ship behind a config/label release
  without touching routing core.

## Non-goals

- No owner-specific defaults (ADR-0024 decision 3): the Mistral/Claude
  subscription economics stay in the user layer.
- No hardcoded model names anywhere (ADR-0025) — whatever ranking rule
  is chosen in 1.4 must be generic; the free-tail situation is evidence, not a rule target.
- OD7 (model-identity mapping, quality cascade) stays its own
  workstream, but Task 0 depends on its identity audit for the free-tail
  scores.
- No taxonomy changes in phase 1 (explicitly staged per owner decision).

## Risks

- **Alias `simple` collision** — mitigated by the documented one-time
  semantic change; shipped config migrates to canonical names in the
  same release.
- **Cost regression for payg-only users** if a pure-gdpval rule (1.4 option D) picks a
  costlier model within the cap — the caps (`max_cost`) are the guard;
  documented.
- **Identity defects (new, Task 0)** — apodex-1.1-mini takes the parent
  model's score (fuzzy matcher drops `mini`); qwen3.8-27b is under-scored
  by a curated builtin; the scraper discards `creator` and collides AA
  family variants. These are OD7-class defects; ling (the model that
  drives the mid-tier) is CONFIRMED. Fixes are separate from this plan.
- **Classifier noise** — inheritance moves continuation noise to the
  previous category; if the previous category was wrong, the error
  persists. Measured in phase 3 replay, not assumed away.

## Verification log
## Verification log

13. **2026-10-13 (evening): both live-operation defects LANDED on main.** The
    snapshot-drift fix (PR #68, merge 840aabf) and the AA initialModels
    capability fix (PR #69, merge 191d170) went through clean cherry-picked
    branches off origin/main (the original branches sat on laya-spike and
    would have dragged the whole spike into the PRs). PR #69's Sourcery
    round produced 5 genuine findings — all fixed red-first in c654fb5:
    replace-vs-merge persistence (stale profiles lingered), per-field
    Stage-2 merge, record-boundary hardening (unknown AA fields could
    misattribute benchmark scores to the wrong slug), measured-zero coding
    scores, conditional scrape_version stamping. PR #68's round: doc
    contract updated; the concurrent-process finding justified as
    not-a-defect (self-healing fingerprint check). Suite ratchet on
    laya-spike: 2125/3 → **2130/3**; laya-spike merged to 6549c31
    (local, unpushed — the push decision for the spike branch remains with
    the owner). Live activation still needs: pi restart + `/router scan`
    (fills the 32 capability profiles, stamps groups_fingerprint, then
    tactical sorts by coding and planning by briefcase).
 (2026-10-11, independent re-check of this plan)

Corrections made after checking the first draft against the code and the
raw data: (1) the Golden-Set section had been reported as added but never
was; (2) the evidence table counted the 12-line all-groups sweep as
decisions — replaced by real selections and stream shares (apodex 64%,
not ling); (3) fallback inheritance and `category_groups` were listed as
new work but already exist; (4) the "ling wins tactical" mystery is the
ADR-0023 5% window; (5) the owner's mid-tier choice was contradicted by
its own example and the draft implemented a different rule (`rank_by:
gdpval`) — now blocked pending a simulation and a fresh decision;
(6) the 1:1 rename changes trivial/standard behaviour (floors, caps,
tier order) — now listed; (7) the 3b training/holdout design leaked —
now split dev/test; (8) "not an identity bug" for ling was asserted, not
checked — now Task 0; (9) the per-class accuracies quoted in chat for
design/planning/standard (14-17%) were wrong (44-50%); (10) "67 fallback
items are continuations" holds only for part of them.
(11) Task 0 ran (delegate/opus, read-only, offline): ling CONFIRMED,
apodex WRONG (inherits full apodex-1-1 score via `mini` drop), qwen3-8-27b
under-scored; systemic labelKey-overwrite defect. Simulation (delegate/opus,
read-only, offline): replica valid 845/845 + 97/97; B shifts category
standard → sonnet (plan expected no change); D shifts code_complex/fallback
→ GLM, planning/design → opus; GLM already ranks in the free tier
(cost_per_m:0 placeholder).
(12) 2026-10-12: owner decided 1.4 = C-tactical 1630; implemented and
merged (PR #66 identity defects, PR #67 floor). Sourcery rounds on both
PRs read and addressed per AGENTS.md §8: 9 findings on #66 (stale-cache
migration via SCRAPE_VERSION gate, cached-LLM-match variant veto, README
stale example, provenance replace/labelKey/creator-optional fixed;
TAG_SUFFIXES stripping justified as the 2026-09-20 alias design) and 5 on
#67 (explicit fallback chains made authoritative — the derived chain would
have put planning/opus first after the floor; health-aware resolve cascade
— unhealthy tank now falls through to a healthy chain candidate; vacuous
sort test rebuilt; free-tail-in-deep-chain justified as fail-open). Suite
ratchet now 2027 passing / 3 skipped (was 2020/3).
