# Laya spike — build brief (evening of 2026-10-08)

> Branch: `laya-spike` (create from `main` after PR "classifier decision log
> merges; everything the spike needs is in that PR). Ships **disabled** — the
> spike never touches the live routing of anyone but the owner's session that
> enables it, and the first iteration is offline replay only anyway (ADR-0027
> #5: known decisions come from the log, not from re-simulating the chain).

## What "done" means for one evening

1. Laya runs as a local HTTP service answering the replay contract:
   `POST /classify` with `{"prompt": "…"}` → `{"category": "…", "confidence":
   0.0-1.0}` — the nine known categories (`trivial, simple, code_simple,
   standard, code_complex, design, planning, exploration, fallback`).
2. `npx tsx scripts/classifier-replay.ts --records
   ~/.pi/logs/classifier-decisions.jsonl --sessions
   ~/.pi/agent/sessions/<project-dir> --since 2026-09-27 --endpoint
   http://127.0.0.1:<port> --report /tmp/laya-replay.json` produces a
   disagreement report against the known classifier's recorded decisions.
3. A first honest number: agreement rate on the corpus, plus the list of
   disagreements to eyeball (which side is right?).

## Corpus

- **Known-decision prompts**: full-text decision-log records. Requires the
  owner user layer `classifier_log.store_text: "full"` (already set in
  `~/.pi/agent/router-config.user.json`) — records exist from the moment
  the new dist is loaded by a pi session. No history: the log started
  today.
- **Backfill (no known decision — golden-set candidates)**: router-era
  session files. Measured 2026-10-08: 2,785 user prompts → 381 unique in
  `--Users-anierbeck-git-pi-model-router-fork--`. These can only show what
  Laya *would* decide; treat every disagreement as a labeling task, not a
  defect on either side.

## Rules of engagement (from the repo's hard rules)

- **ADR-0025**: no hardcoded models anywhere in shipped source/config; the
  replay contract is generic (any candidate endpoint), Laya specifics live
  on the `laya-spike` branch only.
- **§4 red-first** for anything that lands in a PR from the spike (the
  spike branch itself is throwaway exploration until the integration plan
  picks it up).
- **§1**: nothing here is a release action; no tags, no publish.
- Do NOT integrate Laya into the live classification chain tonight — that
  is the integration plan's Task flow (shadow first, PR#-reviewed). The
  spike proves (or disproves) the comparison method and gives a first
  quality signal.

## Known pitfalls from the plan analysis

- The known classifier's *post-processed* category is what routed (record:
  `final.category`), gated by `MIN_CONFIDENCE 0.5` and
  `fallback`-inheritance — calibrate any Laya confidence gate against the
  gated chain, not raw model output.
- A candidate category outside the nine is counted `invalidCategory` by the
  replay harness — map Laya's output to the nine before shipping the
  adapter.
- Prompt duplicates are deduped (subagent fan-out re-sends); `duplicates`
  counts them — weight the agreement rate accordingly if you care about
  per-turn numbers.
