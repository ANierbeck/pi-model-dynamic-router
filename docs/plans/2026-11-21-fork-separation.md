# Final separation from `a-canary/pi-model-router`

**Status:** approved — 2026-11-21 (owner: rewrite the remaining upstream code,
detach the GitHub fork network, keep a one-line origin note). Starts after
the virtual-models migration (`docs/plans/2026-11-21-virtual-models-migration.md`)
is merged: that migration rewrites several listed files anyway.

**Problem:** The repository is still a GitHub fork of the archived
`a-canary/pi-model-router` ("forked from" label, shared fork network), and 21
files still contain original text: 571 lines at the 2026-11-12 measurement,
0.46 % of today's lines, most of them data and docs (`model-map.yaml` 130
lines, `skills/router-login/SKILL.md` 72, `router-defaults.yaml` 36, `README.md`
63, `PI.md` 39), 165 lines in `src/`. As long as original code is in the tree,
the MIT licence requires the original notice to stay with it, so `LICENSE`
carries two copyright clauses and `docs/upstream-attribution.md` lists the
files. The owner wants the project to stand on its own for 2.0.0: categories,
configuration, routing and tests are new work already.

**Solution:**

1. **Re-measure after the migration is merged.** Same method and thresholds as
   `docs/research/2026-11-12-fork-remainder-measurement.md` (blame with
   `-C -C -C` against the 48 upstream commits, plus 20-token windows against
   the fork point `039d60f`), results in a new `docs/research/` note. The
   migration will have rewritten parts of `src/group-registration.ts`,
   `src/event-handlers.ts`, `src/tools.ts` and `src/stream-orchestrator.ts`;
   the list is taken from the measurement, not from that assumption.
2. **Rewrite what is left, file by file.** New text for the docs and the
   skill, new structure and comments for the data files (the facts in them,
   model names and numbers, are kept where they are still used; check first
   whether `model-map.yaml` and `router-defaults.yaml` are still read at all,
   and delete instead of rewriting where they are not), new code for the
   `src/` lines. Behavior changes are not part of this plan: code rewrites keep
   the existing tests green and add none. `package-lock.json` is generated and
   not copyrightable; it is excluded, as the 2026-11-12 measurement noted.
3. **Re-measure until the list is empty.** Then, in one commit: `LICENSE`
   carries only the owner's copyright, `docs/upstream-attribution.md` keeps
   the history (what was measured, when, and that the list is empty since
   then) and drops the file list, and `test/upstream-attribution.test.ts` is
   changed to pin an empty list and a single copyright clause (red first:
   the pin fails against the two-clause `LICENSE`).
4. **README:** the origin banner shrinks to one sentence of history, e.g.
   "Started in 2026 as a fork of `a-canary/pi-model-router`; no original code
   remains." The attribution paragraph in the licence section goes.
5. **Detach the fork network** (owner action, after step 3 is merged). On
   GitHub: Settings → General → Danger Zone, "Leave fork network" if the
   repository offers it, otherwise a GitHub support request to detach the
   fork. The agent prepares the checklist and verifies afterwards with
   `gh repo view --json isFork,parent` (`isFork: false`). Hard to undo; the
   upstream is archived, so no pull requests to it are lost.

**Open decisions:**

1. Keep the 2026-11-12 thresholds (≥ 50 tokens in token windows or ≥ 4
   blamed lines per file) as the definition of "no original code left".
   Recommendation: yes, so the before and after figures compare.
2. The exact wording of the one-line origin note (step 4).

**Verified against:** `main` @ `9fc43e5` — `docs/upstream-attribution.md`
(21 listed files), `docs/research/2026-11-12-fork-remainder-measurement.md`
(figures above), `gh repo view --json isFork,parent` (`isFork: true`, parent
`a-canary/pi-model-router`), `LICENSE` (two clauses), README L5 and L1013.
**Not checked:** whether `model-map.yaml` and `router-defaults.yaml` are still
read at runtime; whether this repository's settings offer "Leave fork
network".

**Related:** `docs/plans/2026-11-12-fork-remainder.md` (the measurement and
the copyright split; done), `docs/plans/2026-11-21-virtual-models-migration.md`
(runs first).
