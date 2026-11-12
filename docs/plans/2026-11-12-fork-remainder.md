# How much of the original `pi-model-router` is left, and what the fork says about it

**Status:** in progress 2026-11-12 — measured. Owner decision on the copyright lines taken 2026-11-12 (per-file split, implemented locally, not yet pushed); banner and fetch scope still open.

**Problem:** This repository is a fork of `a-canary/pi-model-router` (README banner, the copyright line `a-canary` in `LICENSE`). The owner wants to separate from the base project before 2.0 and to decide what the fork relationship should say about the original. The upstream package declares `"license": "MIT"` but has no licence text of its own, so the notice must not be dropped before that is settled (TODO.md, review item of 2026-11-11).

**Solution:** The measurement is done and recorded in `docs/research/2026-11-12-fork-remainder-measurement.md`. Its result, on the history held by this repository:

- 0 of the 15 upstream files still exist byte-identical at `HEAD` (10 changed, 5 deleted).
- Upstream code still present at `HEAD`: 571 of 2933 baseline lines (about 19.5 %, an upper bound), which is 0.46 % of today's text lines (125 336).
- Where the surviving upstream lines sit: most are data and docs (`model-map.yaml` 130 of 225 lines, `skills/router-login/SKILL.md` 72 of 118, `router-defaults.yaml` 36). The code share is 165 lines in 11 `src/` files, mostly code extracted from `index.ts` (`stream-proxy.ts` 57, `scan-runner.ts` 22, `limit-glue.ts` 16, `group-registration.ts` 15).

No code or licence change follows from the measurement by itself. The next step is the owner's decision on the options below, then one follow-up plan for the chosen option.

**Open decisions (owner):**

1. Does the README banner (“Fork of `a-canary/pi-model-router`”) stay as it is? Options: keep, reword, or remove.
2. ~~Does the second copyright line in `LICENSE` stay?~~ **Decided 2026-11-12 (owner):** files that still contain original code keep the original notice; every other file carries the owner's name only. Implemented: `LICENSE` (two clauses), `docs/upstream-attribution.md` (21 files, method), `test/upstream-attribution.test.ts`. The upstream has no licence file to check the wording against; the notice stays on the MIT side.
3. Is the measure as recorded sufficient? It counts lines in this repository's history only. The upstream repository may have commits after `2026-04-02` that were never fetched; fetching them would change the baseline. Decide whether that matters before 2.0.
4. Is the fork relationship (`fork of`) kept in the package metadata and the `repository` field? Not checked yet; decide with item 1.

**Verified against:** `HEAD` `d7809f2` on branch `docs/audit-findings-2026-11-12` (based on `main` `dc77245`). Upstream history: the 48 commits by `a-canary` and `Aaron Canary` reachable from the fork point `039d60f` (2026-04-02). The first fork-authored commit is `784bebb` (2026-06-12). Not checked: the upstream repository on GitHub itself (not reachable from this repository; it may have commits after the fork point).
