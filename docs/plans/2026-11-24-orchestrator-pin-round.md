# Orchestrator pin round: the 210 OPEN mutants of N12

**Status:** proposed — 2026-11-24. Follows from
`2026-11-24-orchestrator-mutation-ledger.md` (its step 4: many real gaps
get their own plan).

**Verified against:** `main` @ `98e6259`; the full-suite recheck of the
293 unledgered `src/stream-orchestrator.ts` mutants from nightly
45406167652 (`docs/mutation-data/nightly-orch-n12.json`). The counts below
come from that file. I did not read every OPEN mutant against the code. The
cluster column is mechanical, by mutator, and is not a verdict.

## Problem

210 orchestrator mutants have no verdict. 206 survive the full suite, 3
time out and 1 kill is unconfirmed. The carry-over keeps them in triage,
so every nightly shows them again until someone rules on each one.
By region (text = string mutants, call = removed call or block, cond =
condition, operator or arithmetic):

| region (lines on `98e6259`) | open | text | call | cond |
|---|---|---|---|---|
| helpers 54–217 | 5 | 4 | 0 | 1 |
| class helpers 366–546 | 7 | 3 | 0 | 4 |
| `openGroupStream` 555–1067 | 27 | 5 | 4 | 18 |
| `driveStream` / `classifyBehindPin` / `failStream` 1068–1148 | 6 | 3 | 3 | 0 |
| walk main loop 1149–1639 | 66 | 45 | 4 | 17 |
| cascade, overflow, breaker check 1640–1699 | 9 | 1 | 0 | 8 |
| breaker probe 1700–1799 | 42 | 10 | 10 | 22 |
| cooldown collapse 1800–1948 | 35 | 15 | 8 | 12 |
| final error, helpers 1949– | 13 | 3 | 1 | 9 |

Known reasons that the suite misses them (from slice 2, still valid):
user-visible narration that no test reads, recording-seam calls whose
effect is state only (cooldown, session errors, breaker, turn latency,
local slot), mock streams that ignore abort signals, and walk states that
need empty candidate or error lists.

## Solution

One batch per region, smallest first, the same loop as N12:

1. Read each mutant against the code. Rule it EQUIVALENT (with a reason)
   or a gap. Owner decision 2 of `2026-11-04-orchestrator-mutation-triage.md`
   applies: a log line that names a decision is pinned, other log text is
   equivalent. User-visible narration (`pushRouterInfo…`, `pushError` in
   the aggregate error, `pushStreamError`) counts as behaviour.
2. Pin the gaps red-first. Each kill needs evidence from
   `scripts/mutation-recheck.ts --tests <file>` (red on the mutant, green
   on the clean tree).
3. Move each row in `nightly-orch-n12.json` from OPEN to REAL-KILLED or
   EQUIVALENT, then re-backfill and recheck with the carry-over.
4. Close the batch with a `docs/mutation-triage.md` entry, the AGENTS §4
   count, and gates.

Fixtures likely needed: a session-errors or cooldown reader for the seam
calls, a stream that honours abort signals, and a breaker-probe walk with
`rate_limit_wait_max_ms` set.

## Open decisions

1. **Timing.** Run this round before or after the 2.0.0 release path? It
   adds tests only, no production change.
2. **Thin reachability.** Some condition mutants differ only with empty
   candidate or error lists, which slice 2 (mutant 871) could not build.
   Ledger them as equivalent-in-reachable-states with a reason, or invest
   in a fixture?

## Steps

- [ ] helpers, class helpers, `driveStream` and siblings (18)
- [ ] cascade, overflow, final error (22)
- [ ] `openGroupStream` (27)
- [ ] cooldown collapse (35)
- [ ] breaker probe (42)
- [ ] walk main loop (66)
