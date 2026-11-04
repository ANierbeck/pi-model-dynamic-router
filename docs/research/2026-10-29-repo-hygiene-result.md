# Repo hygiene — result (numbers only)

**Plan:** `docs/plans/2026-10-29-repo-hygiene.md`
**Measured:** 2026-11-04 on `main` at `fde54f8` (after PRs #83–#88), against the first committed baseline (`bfc49c3`, 2026-10-29) and the Laya-spike merge (`38d2a27`, 2026-11-02).
**Gate:** `node scripts/redundancy-report.ts`, ratcheted by `scripts/redundancy-baseline.json` and `test/redundancy-baseline.test.ts`.

## Redundancy counts

| count | before | after | note |
| --- | --- | --- | --- |
| stale group names in shipped docs | 52 | **0** | pinned at 0 |
| root files outside the allowlist | 5 | **0** | pinned at 0 |
| duplicate function names | 6 | **0** | pinned at 0 |
| repeated 6-line test blocks (≥ 3 files) | 58 | **47** | ratchet lowered with each step |
| plans missing from `docs/plans/README` index | — (gate added) | **0** | new gate |
| plans without a Status line | 24 | 23 | historical plans; not a Phase target |
| test files mocking `ollama-utils` | 27 | 27 | not touched, see below |

## Repository

| measure | before (`38d2a27`) | after (`fde54f8`) |
| --- | --- | --- |
| tracked root entries | 34 | 29 |
| `TODO.md` lines | 850 | 631 |
| test files | 201 | 207 |
| tests passing / skipped | 2444 / 3 | 2517 / 3 |
| coverage thresholds (stmts / branches / funcs / lines) | 63 / 76 / 63 / 63 | 63 / 76 / 63 / 63 (unchanged) |
| coverage measured | — | 88.76 / 82.23 / 87.85 / 90.11 |
| `npm audit --omit=dev` | 0 | 0 |

Test count grew because every fix in the period carried its regression test; the two test deletions (Phase 4 Step 4) removed 2.

## Test deletion evidence (Phase 4 Step 4)

Stryker run 41434044059: 834 covering tests, 386 with a unique kill, 297 containment candidates, 186 of them same-file. Assertion-level review: 0 of 186 are a subset of their container; 2 byte-identical tests deleted. Detail: `docs/research/2026-11-03-test-redundancy-evidence.md`.

## Not reached

- Phase 4 Step 5 (split pin files over 1,000 lines): built and measured, deferred — it raises `repeatedBlocks` 47 → 57 with no assertion changed.
- `ollamaMockFiles` stays 27: the mock block varies per file; only blocks repeated verbatim in ≥ 5 files moved.
- Phase 5 Step 5 (`scripts/` layout): not applicable (owner decision 5).

## Review (AGENTS.md §1)

Independent review of `38d2a27..fde54f8` on 2026-11-04: 2 Critical, 6 Important, 5 Minor. The hygiene part (Phases 0–5) was found behaviour-preserving; the findings concern the sub-call fix of PR #86 and are tracked in `TODO.md` and the PR that fixes them, not here.
