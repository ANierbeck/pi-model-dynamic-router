# Fork remainder: how much of the upstream `pi-model-router` is still in this repo

**Status:** measured 2026-11-12 (read-only; no repository file was changed to take the measurement). Decisions belong to the owner — see `docs/plans/2026-11-12-fork-remainder.md`.

**Verified against:** `HEAD` `d7809f2` on branch `docs/audit-findings-2026-11-12` (based on `main` `dc77245`). Upstream history: the commits of `a-canary` and `Aaron Canary` reachable from the fork point `039d60f` (2026-04-02).

## Method

- **Fork point.** `039d60f` is the last commit by the upstream authors (`a-canary`, `Aaron Canary`) on the single history of this repository; the first fork-authored commit is `784bebb` (2026-06-12). The history holds 48 upstream commits; 1082 commits came after the fork point.
- **Baseline.** Every file that exists at `039d60f`: 15 files, 2933 lines excluding `package-lock.json` (the lockfile is generated and is not counted as authored code; with it the baseline is 8417).
- **Survival per file.** `git blame --line-porcelain -C -C -C HEAD -- <file>` for every text file of `HEAD` (`.ts .js .mjs .cjs .json .md .yaml .yml .py .sh .txt .html .css`, 533 files). A line counts as *upstream* when the commit that last wrote it is one of the 48 upstream commits. `-C -C -C` makes blame follow lines moved or copied between files, so code extracted from `index.ts` into `src/*.ts` is still counted.
- **Limit (direction).** A fork line that happens to equal an upstream line (closing braces, `);`, blank lines) can be counted as upstream. The survival figures are therefore an upper bound, not an exact count.

## Result

| Measure | Value |
|---------|-------|
| Upstream files that still exist byte-identical at `HEAD` | **0 of 15** (10 changed, 5 deleted) |
| Upstream lines still at the same path (blame, no move detection) | 405 of 2933 (13.8 %) |
| Upstream lines still present anywhere at `HEAD` (`-C -C -C`) | **571** of 2933 baseline lines (≈ 19.5 %) |
| Upstream-attributed lines as a share of all `HEAD` text lines | 571 of 125336 (**0.46 %**) |

Strictly on the 15 original paths, 407 of 2933 baseline lines (13.9 %) still exist; the difference to 571 is upstream code that moved into new files (mostly the `index.ts` extraction into `src/*.ts`).

Per category (all files at `HEAD`, lines blamed to the upstream commits):

| Category | Files | Upstream lines | Fork lines | Upstream share |
|----------|-------|----------------|------------|----------------|
| `test` | 265 | 0 | 58282 | 0.0 % |
| `docs` | 130 | 2 | 27052 | 0.0 % |
| `src` | 73 | 165 | 26079 | 0.6 % |
| `root` | 16 | 330 | 6057 | 5.2 % |
| `scripts` | 32 | 0 | 5647 | 0.0 % |
| `spikes` | 9 | 2 | 746 | 0.3 % |
| `skills` | 3 | 72 | 476 | 13.1 % |
| `.github` | 4 | 0 | 282 | 0.0 % |
| `laya-models` | 1 | 0 | 144 | 0.0 % |

Per upstream baseline file:

| File at `039d60f` | Base lines | Still at `HEAD` | Same path (blame) | Anywhere (`-C -C -C`) |
|-------------------|-----------|-----------------|-------------------|------------------------|
| `package-lock.json` | 5484 | yes | 899 | 1841 |
| `index.ts` | 1412 | yes | 39 | 39 |
| `model-utils.test.ts` | 278 | no | 0 | 0 |
| `routing.test.ts` | 273 | no | 0 | 0 |
| `skills/router-login/SKILL.md` | 141 | yes | 72 | 72 |
| `model-map.yaml` | 131 | yes | 130 | 130 |
| `pass-parser.test.ts` | 130 | no | 0 | 0 |
| `model-utils.ts` | 115 | no | 0 | 0 |
| `README.md` | 114 | yes | 63 | 65 |
| `PI.md` | 113 | yes | 39 | 39 |
| `integration.test.ts` | 98 | no | 0 | 0 |
| `router-config.json` | 44 | yes | 1 | 1 |
| `package.json` | 43 | yes | 20 | 20 |
| `router-defaults.yaml` | 36 | yes | 36 | 36 |
| `.gitignore` | 5 | yes | 5 | 5 |

Files deleted since the fork point: `integration.test.ts`, `model-utils.ts`, `model-utils.test.ts`, `pass-parser.test.ts`, `routing.test.ts`.

## Caveats

- **Only the history in this repository is measured.** The upstream repository may have commits after `2026-04-02` that were never fetched here; they are not in the baseline.
- **Attribution, not authorship.** Blame reports the commit that last wrote a line; a fork rewrite that keeps an identical line is invisible.
- The `LICENSE` file did not exist at the fork point; the upstream `package.json` declares `"license": "MIT"`. HEAD's `LICENSE` (added in `2b74a5b`, 2026-11-11) carries both copyright lines.

## Reproduce

`git blame --line-porcelain -C -C -C HEAD -- <file>`; a line is upstream when its commit is one of `git log --format=%H --author=a-canary --author="Aaron Canary"`. The measurement script was run from `/tmp` and is not committed; it can be committed on request.
