# Budget pacing counts the wrong spend

**Status:** proposed — 2026-11-25. **Scheduled after 2.0.0** (owner
decision 2026-11-25): 2.0.0 ships the pacing as it is today; this plan is
the first budget round after the release.

**Verified against:** `main` @ `d29f01c`; the owner's user layer
(`providers.mistral.budget = { amount: 300, unit: "usd", period: "month",
reset_day: 1 }`); `~/.pi/logs/classifier-decisions.jsonl` (`pool` records,
2026-11-19..25); the per-project `.pi/cache/router-state.json` files of
pi-model-router-fork and project A; the Pi 1.6.0 catalog
(`@earendil-works/pi-ai/dist/providers/data/mistral.json`) and one Pi
session step's `usage.cost`. Not checked: what Mistral itself counts
against the account limit (the console figure for November was not
compared).

## Problem

`providers.<p>.budget` (README "Budget Pacing", `src/budget-pacing.ts`)
demotes a provider that spends faster than the linear target of its
billing window. The counter behind that verdict is wrong in four ways,
so the verdict is wrong too.

1. **The counter is per project, the budget is per account.**
   `pacedProviders()` (`src/budget-pacing.ts:166`) reads
   `this.cache.usage_log`, and `usage_log` is an instance key
   (`src/cache.ts:35`) stored in `<cwd>/.pi/cache/router-state.json`
   (`src/cache.ts:146-157`). A provider budget covers every project.
   Evidence, same days, same user layer: every Mistral candidate in
   pi-model-router-fork carries the `paced` flag (100 %, 7656 candidates,
   2026-11-19..25); in project A, project B, project C
   and project D none does (0 %).
2. **The USD estimate prices every token at the input price.**
   `providerSpend()` (`src/budget-pacing.ts:137-156`) adds
   `tokens × effCost(ref) / 1M` for `unit: "usd"`. `tokens` is input +
   output + cacheRead + cacheWrite (`src/cache-stats.ts:46`), and `effCost`
   is the registry **input** price (`src/metrics.ts:698-700`). Mistral's
   catalog prices cache reads at 10 % of input, and 93.8 % of the
   November Mistral tokens in pi-model-router-fork are cache reads. The
   counter shows about $785 for November there; Pi's own step cost
   (`usage.cost.total` in the session files) is $117 for that project and
   $161 for all projects, against a linear target of $243 on 2026-11-25.
   Mistral was on pace and still demoted. Output tokens go the other way
   (priced at input, about 3× too low), but they are a small share. The
   numbers are in `docs/research/2026-11-25-budget-pacing-counter.md`.
3. **Not every step reaches the log.** For project A the project
   log holds 42M Mistral tokens since its first entry on 2026-11-24, Pi's
   session files (parent and subagent runs) 195M for November. Why the
   gap exists (subagent child processes, the log starting on 11-24, or
   both) was not investigated.
4. **The log is shorter than the window.** Both writers keep 30 days
   (`src/event-handlers.ts:596-598`, `src/cache.ts:444-446`), a billing
   window can be 31 days long, so the first day of the window drops out
   before the window ends.

Side effect, not verified: with Mistral permanently demoted in the
router's own repo, more turns went to the subscription provider. Whether
that contributed to the Opus surge of 2026-11-20..24
(`docs/research/2026-11-24-opus-surge-gdpval-variant.md`, on PR #211) was
not checked.

## Solution

Count the spend Pi already computes, in one place for all projects, for
the whole window.

1. **Record Pi's step cost.** Every assistant message carries
   `usage.cost.total`, which Pi computes per component from the catalog
   price (input, output, cacheRead, cacheWrite; a session step was checked).
   Add `cost?: number` to `UsageLogEntry` (`src/types.ts:862`) and set it
   in `buildUsageLogEntry` (`src/cache-stats.ts:38`) when
   `u.cost.total` is a finite number ≥ 0. No second price table, no
   estimate for new entries.
2. **Sum the recorded cost.** In `providerSpend()` for `unit: "usd"`: an
   entry with `cost` adds `cost`; an entry without it (written before step
   1) keeps today's estimate. That way the change needs no migration, and
   the old entries age out within one window.
3. **One counter across projects.** Pacing reads a global usage ledger
   instead of the project log. The ledger lives in the router's state
   directory next to `scan-cache.json`, holds `{ ref, ts, tokens, cost? }`
   only, and is written with the same merge-on-write as the project file
   (`appendInstanceArray`, `src/cache.ts:99`), because several Pi processes
   in different projects write at the same time. The project log stays as
   it is for `/router cost` and the context-compaction reader. Before
   building it, find out why project A's log misses most of its
   steps (problem 3): if subagent child processes do not record usage,
   the ledger must be written from them too, or it repeats the gap.
4. **Keep the whole window.** Retention for the ledger: 32 days, so a
   31-day window is always complete. The project log keeps 30 days.
5. **Docs.** README "Budget Pacing": what the counter counts (Pi's step
   cost, all projects), that `unit: "usd"` on a subscription provider
   counts $0 when the catalog price is 0 (use `unit: "tokens"` there), and
   the 32-day ledger. `docs/config-reference.md` the same. CHANGELOG
   entry.

Dead code found while checking (AGENTS §7): `RouterCache.addUsageLogEntry`
(`src/cache.ts:441`) has no production caller; the real writer is
`src/event-handlers.ts:596`. Remove it in step 3 (its only user is
`test/cache-per-project-state.test.ts`, which moves to the real writer).

### Tests (red first, AGENTS §4)

- Step 1: `buildUsageLogEntry` with `cost: { total: 0.12 }` → entry has
  `cost: 0.12`; with no cost / NaN / negative → no `cost` key.
- Step 2: a budget of $10, entries with `cost` summing $4 and `tokens`
  whose input-price estimate is $40 → not paced (red today: paced).
  A legacy entry without `cost` still uses the estimate.
- Step 3: the gap from problem 3 has a reproducing test before its fix.
  Two `RouterCache` instances with different project dirs record
  usage for the same provider → `pacedProviders` in either sees the sum
  (red today: each sees only its own). Concurrent writes from two
  instances lose no entry.
- Step 4: an entry 31 days old inside a 31-day window still counts (red
  today: trimmed at 30 days).

## Open decisions

1. **Ledger location:** router state dir next to `scan-cache.json`
   (recommended: it already holds global router state), or
   `~/.pi/agent/`.
2. **`/router cost` estimate:** its windows exclude cache reads
   (`src/cost-tracker.ts:283`), pacing includes them at input price — two
   different estimates for the same spend. Switch `/router cost` to the
   recorded `cost` in this round, or leave it for the visibility plan below?
3. **Not in this plan, each needs its own:** showing pace and spend in
   `/router status` (today it shows nothing about pacing); what happens at
   100 % of the budget (today the provider is only demoted, never
   excluded).
