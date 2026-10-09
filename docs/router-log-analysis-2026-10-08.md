# Router Log Analysis — Effects of the Changes Since the 1.6.1 Release

**Window analyzed:** 2026-10-05 (1.6.1 release) → 2026-10-08, 23:28 CEST
**Mode:** analysis only. No optimizations or code changes were made (owner instruction 2026-10-08).

## 1. Sources & Method

- `~/.pi/logs/router.log` (global, 50,913 lines, 2026-09-27 → today, UTC timestamps,
  `[<projectDir>/<pid>]` tags) and the project-local mirror
  (`<repo>/.pi/logs/router.log`, 39,305 lines, untagged).
- `<repo>/.pi/cache/router-state.json` — `usage_log` (7,134 entries; tokens include
  cacheRead since Phase 5a).
- `~/.pi/agent/claude-bridge.log` — root-cause lookup for the breaker trip.
- Git timeline `v1.6.1..main` (75+ commits) to date every feature.

**Caveat that shaped the whole method:** the version line
`pi-model-router v1.6.1 loaded` is **stale** — `package.json` was never bumped after
release prep, so *every* process since the release logs "v1.6.1", including ones that
run the full 1.7.0 code. Code identity was therefore established via **feature
fingerprints** in the log (e.g. `[routing]` decision lines, `[paced]` markers,
breaker narrations), cross-referenced with dist build times and the commit timeline.
The extension is a symlink to this repo (`~/.pi/agent/extensions/pi-model-router ->
../../../git/pi-model-router-fork`), so **every pi process loads the `dist/` state of
its own start time** — the log is a mix of code generations, segmented below.

## 2. Code-Version Timeline (what was actually running when)

| Window (UTC) | Live code | Evidence |
|---|---|---|
| ≤ 2026-10-05 08:49 | released 1.6.1 | first `v1.6.1 loaded` (pid 91031) |
| 10-05 10:58 → 10-06 08:33 | 1.6.1 (main session pid 55580) | opus still rank-1 strategic |
| 10-06 09:33 → 10-06 21:33 | + task-type Phase 0/1/5a (PR #36, 07:59Z) | `[routing]` lines appear; sonnet rank-1 (pids 37452, 45414, 29137) |
| 10-06 18:04 → 10-07 | worktree lanes (round-a…round-d) run branch dists | worktree-tagged processes |
| 10-07 (day) | + ADR-0025 B/C/E, R1 triage | subscription cost 5e-7 → 0.000002 in decisions |
| 10-07 20:35 → | + breaker Phases 2–4, budget pacing, compaction 5b (PR #56) | — |
| 10-08 16:33 → 21:20 | main session pid 13585 on post-#56/#58 dist | `[paced]` markers, breaker trip, locale parser present |
| 10-08 21:21 → now | **pid 59038 on dist 19:10Z = complete 1.7.0 code** (PRs #55–#62; #61/#62 test/docs-only) | current process |

Pi was **restarted tonight at 23:21 CEST** (pid 59038); the session was resumed. From
this point on, the full 1.7.0 feature set is live in the main session for the first time.

## 3. Observed Effects (evidence first)

### 3.1 Sonnet-before-Opus ranking fix (Phase 1, d3aaa3b) — fully effective

Group-routing opus selections: **Oct 3: 91, Oct 4: 132, Oct 5: 62, Oct 6: 85 — then
zero on Oct 7 and Oct 8.** All 85 Oct-6 selections came from pid 55580 (started Oct 5,
pre-fix dist) and stopped at 06:59Z; every process started after PR #36 merged
(07:59Z) ranks `claude-sonnet-5-5` first in `strategic`/`planning` (rank-1 audit:
opus-first only in 55580, 7 decisions; sonnet-first in all 10 later processes).

The 78 opus stream-finishes on Oct 8 are **not** group routing: they are `MHINT`
lines (`MHINT: claude-opus-5-5 · claude-bridge/claude-opus-5-5`) — explicit model
switches from the conversation (16–17h window). The group path never picked opus
after the fix. 903 MHINT lines total in the log show the explicit-override path is
well used and correctly resolves through claude-bridge when the direct anthropic
provider has no credentials (`HINT: skipping unusable refs (no handler/credentials)`).

### 3.2 Budget pacing (Phase 4, 3577319) — live, demotion visible

Since pid 13585 (Oct 8 16:33Z) **every mistral ref carries `[paced]` and sits last in
every group** (`budget: 250 usd/month, reset_day 1`, user layer). Visible in the same
boot: pre-config ranking had GLM first (`gdp=1653 cost=0`), post-config ranking puts
ling-3.1-flash/apodex first with GLM demoted. Consequences in the numbers:

- apodex-1.1-mini:free selections: **19 (Oct 4) → 235 (Oct 8)**; the free pool took
  the cheap-group traffic (36.4M openrouter tokens on Oct 8 at cost 0).
- mistral token share: **85.6M (Oct 7) → 20.3M (Oct 8)** (usage_log, incl. cacheRead).
  The remaining GLM traffic is the *evening cascade* — after the free pool capped and
  claude-bridge broke, traffic legitimately fell back to GLM (pace-not-block by
  design: 18:59:59 breaker trip → GLM served immediately, 52 selections in hour 19).
- By effCost estimate (1.4 USD/Mtok for GLM, ignoring cache-read discounts): Oct 7 ≈
  $120, Oct 8 ≈ $28. The real spend is lower because cached tokens are not billed
  like fresh tokens, but the pacing counter conservatively counts them (documented
  Phase 5a behavior).

### 3.3 Provider circuit breaker (ADR-0026) — one trip, exactly as designed

**Oct 8, 18:59:59Z (pid 13585):** haiku-4-5, sonnet-5-5 and opus-5-5 each finished
`stop, 0 chars` within 1.1 ms during a `fallback→operational` cascade. The breaker
tripped: `claude-bridge looks wedged: 3 distinct model(s) returned empty responses
within 1 s — skipping its models for 2 min`, the cascade continued to
`mistral/zai-glm-5-3`, which served the turn 10 s later. Total wasted attempts: 3
(versus the pre-breaker behavior of burning every bridge model plus individual
cooldowns).

**Root cause (claude-bridge.log):** `provider: orphaned tool result after abort,
emitting end_turn` — the bridge session was in a corrupted state after an aborted
attempt, not an Anthropic outage. The 2-min skip outlived the state and the bridge
recovered. Notable: the wedge-evidence heuristic correctly recognized
*unusable-provider*, not just *provider-down* — but this also means state corruption
can masquerade as a provider wedge (relevant for future tuning; the trip rule sees
"3 distinct models empty within 1 s").

The bridge produced further intermittent empty stops during the evening (2 at 16h,
4 at 20h — again `orphaned tool result`) **without** re-tripping the breaker: those
empties were spread over time / fewer distinct models. No user-visible failure
resulted; the cascade absorbed each one.

### 3.4 Cross-group fallback cascade — working, moderate frequency

`All models in fallback failed, trying operational…` fired 8× (Oct 4), 2× (Oct 6),
5× (Oct 8). Each event recovered on the next group without reaching the user as an
error.

### 3.5 Retried-narration / truncation path (B3 machinery) — live in production

Oct 8 18:55:24: apodex finished `stopReason: length, 0 chars` → narration
`output truncated at max tokens (task incomplete), trying openrouter/inclusionai/
ling-3.1-flash` → ling served the retry. The exact narration block the B3 tests pin
is exercised by real traffic. (Oddity worth remembering: a `length` stop with
**0 chars** — the free model aborted at the token ceiling without emitting text.)

### 3.6 Rate limits & cooldowns — no collapse since Sept 27

- `Total cooldown collapse`: **0 events since 2026-09-27** (all 16 hits are from the
  incident day; the wait-branch narrations in the log are the Sept-27 post-fix ones).
- Rate-limit waits: 0 events since Oct 4.
- Oct 8 18:56–18:59: the free pool tripped per-minute caps in cascade
  (apodex → ling → gemma-4-26b → gemma-4-31b → north-mini-code, each
  `rate limit/spend limit reached (backing off 60s)`); all handled with inline 60s
  backoffs, no collapse, cascade continued to claude-bridge/mistral.

### 3.7 Free-tier reality (unchanged root problem, new visibility)

- Every boot probe shows the `:free` endpoints at the **daily cap**
  (`429 free-models-per-day`) on Oct 6/7 — the caps are exhausted most of the day;
  Oct 8 the pool survived until ~18:59Z, then capped in the cascade above.
- `openrouter/inclusionai/ling-3.1-flash` (not `:free`-suffixed) fails **permanently**
  with `402: Insufficient credits. This account never purchased credits` — yet it is
  **rank-1 in every cheap group** whenever its cooldowns expire (gdp=1622 > apodex
  1197). It burned 9 selections Oct 8 plus failed picks. A dead-by-account candidate
  occupying the top slot is a recurring finding.
- **Degenerate free-model outputs:** Oct 8 18:56–18:58, apodex served 7 consecutive
  `toolUse, 2 chars` turns. All guards passed (the repetition guard needs longer
  repeated units). Free minis can burn a tool loop with micro-outputs.

### 3.8 Classifier chain (ADR-0025 C1/C2) — derived chain works, local leg dead with Ollama

- All 22 `[classifier-local-probe]` lines say `Ollama unreachable or wedged — keeping
  the previous local classifier list`. Ollama is **actually down** (verified:
  port 11434 unreachable now) — not a router regression.
- With the local leg dead, classification falls to the **probed cloud chain**:
  `Cloud fallback trying 8 model(s) (probed): mistral/ministral-3b-latest, …` →
  `mistral/ministral-3b-latest succeeded (via pi completeSimple)` — 11 events Oct 8,
  low volume thanks to the classification cache.
- **Per-boot probe overhead:** every process start runs a serial probe of 20
  candidates (~38 s measured for pid 13585: 16:34:00 → 16:34:38). With 34 boots on
  Oct 6, 27 on Oct 7 (subagents + worktree lanes), that is ~30–40 probe rounds/day of
  API chatter, and each round consumes free-tier quota.

### 3.9 Features live but not exercised in the window

- **Locale reset-time parser (PR #58):** live since Oct 8 06:15Z, but no de-DE
  reset-string event occurred (the bridge failed with empties, not 429-with-reset).
  Unverified in production traffic.
- **Cache-aware compaction hint (Phase 5b):** `context_budget.enabled = true` in the
  user layer, but `compacting now would pay off` never logged. Either the threshold
  heuristic never fired or the hint path was not reached. Unverified.
- **Fallback-category inheritance (dd43a67):** no log fingerprint exists for
  per-turn classification outcomes, so the inheritance cannot be verified from
  router.log at all (see §5).

### 3.10 Confirmed-fixed state holds

- **Mistral 422 "store" incident:** zero 422 status errors since Oct 4 (earlier grep
  hits were numeric coincidences in char counts/timestamps).
- **Log-eating narration storm** (the ~75 % single-pattern bloat from Sept 27):
  current file grows normally; no repeated-pattern explosion since.
- **Exit-listener dedupe (PR #48):** no double `exit` registrations observed; the
  double-bundle hazard is still *visible* though (§5, boot quirk).

## 4. Quantitative Summary

Model selections via group routing (per day):

| Day | opus | sonnet-5-5 | sonnet-5 | GLM-5-3 | apodex:free | other notable |
|---|---|---|---|---|---|---|
| Oct 3 | 91 | – | 4 | 34 | 1 | – |
| Oct 4 | 132 | – | – | 1054 | 19 | ling 1, qwen 1 |
| Oct 5 | 62 | – | – | 289 | – | ling 11 |
| Oct 6 | 85 (≤06:59Z, old pid) | 59 | 51 | 402 | 15 | sante 15 |
| Oct 7 | **0** | – | – | 380 | 2 | – |
| Oct 8 | **0** (+78 via MHINT) | 36 | – | 117 | 235 | north-mini 38, gemma 6, ling 9 |

usage_log tokens per provider (incl. cacheRead from Oct 6 on — not comparable
across the Phase 5a boundary):

| Day | total | mistral | claude-bridge | openrouter |
|---|---|---|---|---|
| Oct 4 | 3.2M | 2.96M | 48k | 198k |
| Oct 5 | 2.2M | 2.16M | 58k | – |
| Oct 6 | 85.3M | 51.2M | 33.5M | 0.6M |
| Oct 7 | 85.8M | 85.6M | – | – |
| Oct 8 | 74.1M | 20.3M | 17.3M | 36.4M |

Errors/events per day: 429s — 103/11/206/156/10 (Oct 4–8; dominated by boot probes
hitting free caps); empty bridge responses — 25/0/15/0/11; bulk_read full-read blocks
(expensive-model guard) — 3/–/16/10/1.

Stream volume: 1292/385/758/424/518 finished streams (Oct 4–8); stopReason mix
overwhelmingly `toolUse` (agent loops), `stop` for finals, 1× `length` (Oct 8).

## 5. Findings (documented, NOT fixed — per owner instruction)

1. **Stale version string:** every post-release process logs `v1.6.1`. A version
   bump (or a build-timestamp in the load line) would make future log analysis
   trivial; today it requires fingerprint archaeology.
2. **Timezone inconsistency:** narrations print local time (`backing off 60s, until
   20:57` at 18:56Z), the log file is UTC. During the Oct-8 incident triage this
   cost several minutes of confusion.
3. **Dead candidate at rank-1:** ling-3.1-flash 402s permanently (account without
   credits) but still tops every cheap group between cooldowns.
4. **Free-minis degenerate loop risk:** 2-char toolUse outputs passed all guards
   (7 consecutive turns, Oct 8 18:56–18:58).
5. **Per-boot probe cost:** ~38 s serial probe per process start × dozens of
   short-lived processes per day (subagents/worktrees); also consumes free quota.
6. **Breaker evidence semantics:** "3 distinct models empty within 1 s" can be
   bridge-session state corruption (orphaned tool result), not provider death —
   correct reaction either way, but relevant if thresholds are ever tightened.
7. **Observability gap:** no per-turn classification-outcome line in router.log —
   fallback inheritance (and the classification mix over time) cannot be evaluated
   from logs, only from `/router status` in the live session.
8. **Boot double-instantiation visible:** each process logs two config-load and
   ranking phases (`[pi/<pid>]` then `[<project>/<pid>]`, different pi-ai module
   paths); the first phase ranks with incomplete state (GLM `cost=0`, no `[paced]`,
   empty planning group). Cosmetic, but misleading when reading boot logs.
9. **`length` stop with 0 chars:** the apodex truncation event (Oct 8 18:55) shows a
   model hitting the token ceiling with no output at all — the retry narration
   handled it, but the "truncated" wording is generous for zero emitted chars.

## 6. What to Watch Next (no action taken)

- Breaker re-trip behavior across longer bridge outages (the evening empties did not
  re-trip — by rule, since they were not "3 distinct models within 1 s").
- Whether pacing + a healthy free pool keeps the mistral share at Oct-8 levels
  (≈ $28 effCost/day) or the evening-cascade pattern dominates on heavy days.
- First production de-DE reset event to exercise the locale parser.
- First `compacting now would pay off` hint now that the full 1.7.0 code runs in the
  main session (pid 59038).
- Ollama daemon status — the local classifier leg is dead until it comes back.
