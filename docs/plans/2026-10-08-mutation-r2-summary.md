# Mutation Nightly R2 — result and wrap-up (2026-10-08, run 37764383801)

**Owner decision 2026-10-08** ("continue with mutation Phase 2") was executed
as follows:

## Result of the last mutation test run
- **92.33 %** (1588/1720), 124 survived + 8 no coverage
- All 132 undetected mutants triaged (`docs/mutation-triage.md`,
  "Nightly R2", `docs/mutation-data/nightly-r2.json`).

## What we could do with the results (and did)
1. **Recheck against the full suite** (`mutation-recheck.ts`): 12 of the 22
   tested candidates were false survivors (perTest coverage attribution never
   attributes the killing test for static/module constants); 10 true
   survivors confirmed.
2. **Closed a real test gap**: the `[paced]` marker of the decision line had
   no test — `test/group-decision-log.test.ts` now pins flag, placement and
   the demotion. RED against all four nightly mutants plus a bypassed and a
   reversed `paceDemote` (red-first, AGENTS.md §4).
3. **Removed §7 duplicates** (behaviour-preserving; suite green):
   `billingTier` → `isFreeModelRef` (its doc comment already claimed that),
   simplified bare-id derivation, two redundant `paceDemote` guards;
   `formatGroupDecision` computes the paced set once per line.
4. **Carry-over tooling** (`scripts/mutation-carryover.ts`, 13 tests,
   sabotage-verified): verdicts persist across runs while the source text is
   unchanged — 111 of the 132 R2 mutants were resolved that way. Downloading
   old nightly artifacts (90-day retention) is no longer needed.

**Planned / open:** Phase 2 scope extension to `src/stream-orchestrator.ts`
(local first report 2026-10-08: 31.5 %, 743 undetected; see the "Nightly R3"
ledger section).

## OpenRouter note (owner)
Credits were deposited → 1000 calls/day (free tier). Unusable for review
subagents: `openrouter/*:free` endpoints are excluded by the workspace
guardrail policy "free-model-training-violation" (verified on a review
attempt: 404, no endpoint available). The fallback was
`mistral/mistral-large-4:off` (works; no shell/git access in the review
session). No paid models were used.
