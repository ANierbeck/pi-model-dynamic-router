# Budget pacing counts the wrong spend

**Status:** proposed — 2026-11-25. **Scheduled after 2.0.0** (owner
decision 2026-11-25): 2.0.0 ships the pacing as it is today; this plan is
the first budget round after the release.

**Verified against:** `main` @ `44eec66`; the owner's user layer (a monthly
USD budget on the `mistral` provider, `reset_day: 1`);
`~/.pi/logs/classifier-decisions.jsonl` (`pool` records, 2026-11-19..25);
the per-project `.pi/cache/router-state.json` files of two projects; the
Pi 1.6.0 catalog (`@earendil-works/pi-ai/dist/providers/data/mistral.json`)
and one Pi session step's `usage.cost`. Not checked: what Mistral itself
counts against the account limit; how to tell a synthetic router error
from a provider error at the `turn_end` handler (step 5 settles it);
whether subagent child processes write usage at all (step 1 settles it).

## Problem

`providers.<p>.budget` (README "Budget Pacing", `src/budget-pacing.ts`)
demotes a provider that spends faster than the linear target of its
billing window. The counter behind that verdict is wrong in four ways, so
the verdict is wrong too. All numbers:
`docs/research/2026-11-25-budget-pacing-counter.md`.

1. **Per project, not per account.** `pacedProviders()`
   (`src/budget-pacing.ts:166`) reads `this.cache.usage_log`, an instance
   key (`src/cache.ts:35`) stored in `<cwd>/.pi/cache/router-state.json`
   (`src/cache.ts:146-157`); a provider budget covers every project. The
   same user layer demotes the provider in one project and not in others
   (research §1).
2. **Every token priced at the input price.** `providerSpend()`
   (`src/budget-pacing.ts:137-156`) adds `tokens × effCost(ref) / 1M`;
   `tokens` includes cacheRead (`src/cache-stats.ts:46`) and `effCost` is
   the registry input price (`src/metrics.ts:698-700`). Cache-heavy
   providers are overstated several-fold and the provider is demoted while
   on pace; Pi's own `usage.cost.total` is the reference (research §2).
3. **Steps missing from the log.** A project's log holds a fraction of the
   tokens its Pi session files hold (research §2); the cause is not
   investigated (subagent child processes, the log starting late, or both).
   Billable usage of failed provider calls is dropped by design: the
   `turn_end` handler skips `error`/`aborted` messages
   (`src/event-handlers.ts:548-560`) even when the provider reported usage.
4. **Log shorter than the window.** Both writers keep 30 days
   (`src/event-handlers.ts:596-598`, `src/cache.ts:444-446`); a billing
   window can be 31 days (research §3).

Side effect, not verified: a permanently demoted provider sends more turns
to the subscription provider, which may have contributed to the Opus surge
of 2026-11-20..24 (`docs/research/2026-11-24-opus-surge-gdpval-variant.md`).

## Solution

Count the spend Pi already computes, once for all projects, for the whole
window, from one canonical record.

1. **Find the gap first.** Reproduce problem 3 in a test (a subagent child
   process with usage) before any ledger code: if children do not record
   usage, the ledger must be written from them too, or it repeats the gap.
2. **Record Pi's step cost with an event identity.** Add `cost?: number`
   and `id: string` to the usage entry (`src/types.ts:862`, set in
   `buildUsageLogEntry`, `src/cache-stats.ts:38`): `cost` from
   `usage.cost.total` when a finite number ≥ 0; `id` the provider's
   response id when present, otherwise a random UUID. Identical
   ref/tokens/timestamp from two projects are then distinct events, and a
   retried write of one event is recognised as the same event.
3. **Sum the recorded cost.** In `providerSpend()` for `unit: "usd"`: an
   entry with `cost` adds `cost`; a legacy entry without it keeps today's
   estimate, so no migration is needed and old entries age out within one
   window.
4. **One global ledger as the canonical spend record.** An append-only
   JSONL file in the router state directory next to `scan-cache.json`, one
   line `{ id, ref, ts, tokens, cost? }` per event, appended with a single
   `O_APPEND` write per line. It is **not** written through
   `appendInstanceArray` (`src/cache.ts:99`): that helper is a
   read-merge-replace, so two processes that read before either writes lose
   the earlier entry on the later replace. Readers dedupe by `id`.
   Pruning (32-day retention, so a 31-day window is complete) rewrites the
   file under an exclusive lock file; a failed lock skips the prune, never
   the append. Pacing reads only the ledger; the project `usage_log` stays
   for `/router cost` and the compaction reader and is no longer a spend
   source, so a crash between the two writes cannot make pacing miss a step
   (the ledger append happens first; the project log is a view).
5. **Failed calls count when billable.** The ledger append runs
   independently of the success path: an `error`/`aborted` assistant message
   with non-zero reported usage is appended, without touching
   `recordOk`/metrics (the failed-turn exclusion stays for those). Synthetic
   router error messages (all-candidates-failed narration) carry no
   provider usage and are excluded; the exact discriminator is verified in
   the red test (a synthetic message with fabricated usage must not count).
6. **Seed the ledger from what exists.** A fresh ledger would undercount
   for the rest of the window. On first open, each Pi process imports the
   entries of its own project's `usage_log` that fall inside the current
   window (ids derived from `ref|ts|tokens|project-hash`, so the import is
   idempotent) and writes an import marker. Projects that are never opened
   again stay uncounted; open decision 2 covers the alternative of
   reconciling from Pi's session files.
7. **Docs.** README "Budget Pacing" (counts Pi's step cost, all projects,
   32-day ledger; `unit: "usd"` on a subscription provider counts $0 when
   the catalog price is 0 — use `unit: "tokens"` there),
   `docs/config-reference.md`, CHANGELOG.

### Tests (red first, AGENTS §4)

- Step 1: the reproducing test for problem 3.
- Step 2: `buildUsageLogEntry` with `cost: { total: 0.12 }` → `cost: 0.12`;
  missing/NaN/negative → no `cost` key. Two entries with identical
  ref/tokens/ts but different ids both count (red today: the key collapses
  them).
- Step 3: a $10 budget, recorded cost $4, input-price estimate $40 → not
  paced (red today: paced); a legacy entry still uses the estimate.
- Step 4: two `CacheManager` instances with different project dirs record
  usage for one provider → `pacedProviders` in either sees the sum (red
  today: each sees only its own); two processes appending concurrently
  lose no line; an entry 31 days old inside a 31-day window still counts
  (red today: trimmed at 30 days); a failed prune lock keeps every entry.
- Step 5: an `error` message with reported usage reaches the ledger and
  leaves metrics/breaker untouched; a synthetic router error does not.
- Step 6: opening a fresh ledger twice imports the project log once; an
  entry older than the window is not imported.

## Open decisions

1. **Ledger location:** router state dir next to `scan-cache.json`
   (recommended: it already holds global router state), or `~/.pi/agent/`.
2. **Seeding source:** each project's own `usage_log` on first open
   (step 6, cheap, converges as projects are opened), or a one-time
   reconciliation from Pi's session files (complete, but reads every
   session transcript and depends on Pi's file layout).
3. **`/router cost` estimate:** its windows exclude cache reads
   (`src/cost-tracker.ts:283`), pacing counted them at input price — two
   estimates for one spend. Switch `/router cost` to the recorded `cost`
   in this round, or later?
4. **Not in this plan, each needs its own:** pace and spend in
   `/router status`; behaviour at 100 % of the budget (today only demoted,
   never excluded). The unused `CacheManager.addUsageLogEntry`
   (`src/cache.ts:441`, no production caller) is removed separately as a
   standalone AGENTS §7 refactor, not part of this plan.
