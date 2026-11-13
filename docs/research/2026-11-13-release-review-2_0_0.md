# Pre-release code review of 2.0.0 (v1.6.1..main, 2026-11-13)

Record of the four area reviews run before the 2.0.0 release proposal, and of
what was done with every finding. Each finding was checked against the code
before it was acted on: several reviewer quotes did not match the repository,
and they are marked below as such.

- Range: `v1.6.1` (`35724d8`) .. `main` (`1a8751f`), 576 commits.
- Reviewer: the requesting-code-review template, one fresh reviewer per area.
- Verdicts: routing/stream core READY (0 findings); Laya integration READY;
  config/CLI READY; scripts/tests/docs READY. No Critical finding in any area.

## Findings and disposition

### Config / CLI

| ID | Finding | Verdict | Disposition |
|---|---|---|---|
| I1 | Lock-busy message should say a retry is safe | Already says so: "try again in a moment" (`src/user-config-store.ts`). The quoted text did not exist. | No change |
| I2 | Stale-fingerprint regeneration is silent | Wrong: the drift branches log at every regeneration (`src/dynamic-config-runner.ts`, `routerLog` on groups and free-models drift). | No change |
| I3 | Unknown-integration error repeats usage | Wrong: each branch returns one usage line. | No change |
| I4 | Project override should be prefixed "NOT APPLIED" | Already explicit: "is not changed — the project config sets it" (`src/commands.ts`). A wording preference, not a defect. | No change |
| M1 | Unreadable snapshot is caught silently | Real (diagnosability): the fingerprint reader now logs before it regenerates. | Fixed, log-only, no test (no behaviour change) |
| M2 | Lock stale threshold 10 s may steal locks on slow disks | Trade-off, not a defect: a 30 s threshold would block every write for 30 s after a crashed writer. | Kept at 10 s |
| M3 | Non-object integration block is silently replaced | **Real defect.** `integrations.laya = "oops"` was overwritten with `{ enabled: true }`. | **Fixed**, red-first (`test/user-config-write.test.ts`) |
| M4 | Origin labels differ between warnings and the origin view | Cosmetic inconsistency; no user-visible error. | Not changed (recorded here) |
| M5 | PATTERN_RE comment should document the glob syntax | The comment already documents `*` as the wildcard. | No change |
| M6 | `applyDelta` should `await` a sleep instead of `Atomics.wait` | `applyDelta` is synchronous (the commands use its result directly); `Atomics.wait` is the only synchronous sleep. | No change |
| M7 | `$schema` in router-config.json | No schema file exists; a `$schema` pointing nowhere would be wrong. | Not changed (post-2.0 idea) |

### Laya integration

| ID | Finding | Verdict | Disposition |
|---|---|---|---|
| I-resume | Same-size partial download accepted without a digest check | Partly real: the final SHA-256 pass always runs, so no corrupt model is installed, but a corrupt full-size partial discarded the whole install instead of being re-fetched. | **Fixed**, red-first (`test/laya-model-install.test.ts`) |
| M-server | Nested async IIFE in the request handler | Style; behaviour identical. | **Refactored** (`laya-sidecar/src/server.ts`); checked by the sidecar tests (20/20), the repo contract tests and a live probe of the 200/400/404/500 paths |
| M-identity | Module-level `_identity` state undocumented | Real documentation gap. | **Documented** (`src/laya-classifier.ts`) |
| M-nonet | No-network test asserts only "incomplete" | Wrong: it asserts the exact message including the missing file. | No change |
| M-validate | `validateIntegration` mutates its argument | Real: callers rely on it. | **Documented** (`src/integration.ts`) |
| (remaining) | `/classify` error handling, head parity, loopback checks, privacy modes | Reviewer confirmed; no finding. | — |

### Scripts / tests / docs

| ID | Finding | Verdict | Disposition |
|---|---|---|---|
| I1 | CHANGELOG says router@1.0.0 is "not published yet" | Quote not in CHANGELOG; the weights are indeed unpublished, so the claim is true in substance. | No change |
| I2 | AGENTS.md test count | Verified: 3160 passing / 3 skipped at review time; now 3166 after this round. | Count updated |
| I3 | Dependabot open-PR cap not pinned | Real gap in the test (the config is correct). | **Added**, mutation-checked (cap 6 turns it red) |
| M1 | `commitExists()` unused | Wrong: used at `scripts/secret-scan.ts:149`. | No change |
| M2 | lint-baseline schema check | Not a defect; the baseline is already pinned at 0 by the ceiling test. | No change |
| M3 | Per-gate timing in pre-push | Enhancement, not a defect. | No change |
| M4 | Comment on the 90-day retention floor | Real (readability). | **Added** (`test/mutation-nightly-config.test.ts`) |
| M5 | `PRE_PUSH_DIRTY_INPUTS` paths | Verified: prettier config files do affect formatting. | No change |
| M6 | `prepublishOnly` guard untested | Real gap. | **Added**, mutation-checked (`test/prepublish-guard.test.ts`) |
| M7 | "15 files" claim in CHANGELOG | Not found in the CHANGELOG; the attribution count is pinned in its own test. | No change |

## Verification

- Full gate after the round: `tsc --noEmit` clean; `npm run lint` 0 findings;
  `format:check` clean; `vitest run` 254 files, 3166 passed / 3 skipped (was
  3160); `npm run build` clean.
- Sidecar: `npm test` in `laya-sidecar/` 20/20; live `/classify` probe of the
  built server: 400 (bad prompt), 200 (classification), 404, 500 (bad JSON).
- Mutation checks for the new pins: the dependabot cap (6 → red, restored), the
  prepublish guard (`true` → red, restored).

## Open

- Nothing from the four reviews blocks the release. The disposition above is the
  complete list of what was not changed, and why.
- The review ran on the Claude bridge model after the earlier OAuth failure; no
  finding depends on which model produced it, because each was checked against
  the code.
