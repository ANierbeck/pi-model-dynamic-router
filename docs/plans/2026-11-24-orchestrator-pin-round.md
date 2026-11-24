# Orchestrator pin round: the 210 OPEN mutants of N12

**Status:** proposed — 2026-11-24. Follows from
`2026-11-24-orchestrator-mutation-ledger.md` (its step 4: many real gaps
get their own plan).

**Verified against:** `main` @ `98e6259`; the full-suite recheck of the
293 unledgered `src/stream-orchestrator.ts` mutants from nightly
45406167652 (`docs/mutation-data/nightly-orch-n12.json`). The counts come
from that file. Not every OPEN mutant has been read against the code yet;
the region split is mechanical, by mutator, and is not a verdict.

## Problem

210 orchestrator mutants have no verdict. 206 survive the full suite, 3
time out and 1 kill is unconfirmed. The carry-over keeps them in triage,
so every nightly shows them again until someone rules on each one.
Their split by code region is in
`docs/research/2026-11-24-orchestrator-mutation-n12.md`.

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
