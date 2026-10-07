# Plan: Provider circuit breaker (cloud + local, one mechanism)

> Backlog item "Cloud-provider wedge circuit breaker" (TODO.md, registered
> 2026-10-06), promoted to a plan on the owner's request. Status:
> **implemented** — Phase 1 (core module + local parity) merged 2026-10-07;
> Phases 2–4 (orchestrator wiring, visibility/volatile state, replay
> validation + ADR-0026) implemented in the circuit-breaker-phases-2-4
> lane, 2026-10-07. Open questions at the end.
> Target line: 1.7.0. Follows AGENTS.md §4 (red-first), §5, §8. **No release
> action is part of this plan (§1).**
>
> Extends [ADR-0016](../adr/0016-local-provider-watchdog.md) (local
> watchdog); complements [ADR-0013](../adr/0013-failure-classification-and-failover.md)
> (per-model transient handling) and [ADR-0008](../adr/0008-learned-model-blocklist.md)
> (per-model permanent failures). Written to satisfy
> [ADR-0025](../adr/0025-no-hardcoded-models.md): provider-agnostic, no
> provider or model names in the mechanism.

## Problem

Every failure-handling mechanism the router has is **per model**: soft
backoff (ADR-0013), health demotion, the Tier-2 blocklist (ADR-0008, 5
failures over ≥ 1 h). The only provider-scoped mechanism, the watchdog
(ADR-0016), covers **local** providers and only counts generation
*timeouts*.

When a **cloud provider or extension wedges as a whole** — its models all
answer with empty responses, stall or time out — nothing says "this
provider is broken". Each candidate of that provider burns its own hop
(and its own timeout, for stalls) before the cascade moves on, and the next
request does it again until per-model cooldowns have accumulated one by one.

### Evidence (verified 2026-10-06 against `~/.pi/logs/router.log`, 5.9 MB)

| Observation | Number |
|---|---|
| failure lines in the log (empty / timeout / stall / provider error) | 719 |
| `claude-bridge` — `empty response (no content, no error reported)` | 235, spread over 6 days (09-27: 96, 10-02: 50, 10-03: 48, 10-04: 22, 10-06: 12) |
| most **distinct models of one provider failing within 60 s** | **6** (`claude-bridge`, 2026-10-04 08:31) |
| example cascade, 2026-10-06 08:03:51 | 4 `claude-bridge` models failed within 16 ms, one after another |
| `ollama` — `provider error: Connection error.` | 172 lines — **not** counted by the watchdog (it only records `empty_timeout`/`stall_timeout`) |
| `mistral` — `provider error` | 263 lines, but mostly **per-model request/shape errors** (400 "reasoning prompt mode", 422 "store") — must NOT count as a wedge |

Reading: a provider-level wedge looks like *several different models of the
same provider failing in the same way in a short window, with no success in
between*. A per-model structural error (400/422/404) does not.

## Verified current mechanics (what the breaker plugs into)

- `src/provider-watchdog.ts` — thresholds (`≥ 2` distinct local models,
  10 min window, flat 5 min cooldown), state `cache.local_provider_health`,
  `recordLocalTimeout` / `recordLocalSuccess` / `isProviderWedged`.
- `src/stream-orchestrator.ts` — two pre-flight skips already exist for
  wedged providers (`nextAttemptableRef` ≈ line 618 for narration lookahead,
  the candidate loop ≈ line 634), and one observer call after soft failures
  (≈ line 922, `empty_timeout` / `stall_timeout` only).
- **Gap found while writing this plan:** a wedge-skip bumps `cooldownSkips`
  but is **not** `isLimited`, so the "total cooldown collapse" safety net
  (≈ line 1010: wait/force-retry the shortest cooldown instead of failing)
  does not see it. If every remaining candidate belongs to a wedged
  provider, today's behaviour is a hard "all candidates failed". Harmless
  for local (cloud takes over); **not acceptable for a cloud breaker** where
  the wedged provider may be the only one configured.
- Persistence: the cache object is written to disk (`saveCache`, debounced /
  every 10 turns) and re-merged on load, so `local_provider_health` and
  `model_health` **do survive a restart** while their timestamps are valid
  (`dist/.cache/scan-cache.json` holds live `model_health` records).
  ADR-0016's sentence "a restart starts clean" is therefore inaccurate —
  corrected in this plan's docs commit.

## Goals / non-goals

**Goals**
1. One provider-scoped breaker for local **and** cloud providers: open after
   provider-level failure evidence, skip the provider's candidates, probe
   again after a cooldown, close on success.
2. Never leave the user without an answer because a breaker is open
   (ADR-0013 driver: *never leave the user with an opaque error if any
   candidate could still answer*).
3. Visible: one narration when it opens (with a fix hint), `/router`
   status, clear command.
4. Provider-agnostic (ADR-0025 class A: locality from `PROVIDER_MAP`, no
   provider names in logic).

**Non-goals**
- No automatic restart of anything (the router never restarts daemons or
  extensions; same stance as ADR-0016).
- No change to per-model cooldowns, health demotion or the learned blocklist
  — the breaker is an *additional*, provider-scoped layer.
- No provider-specific tuning in code.

## Design

### D1 — What counts as provider-level evidence

Counts (one record per distinct model ref, timestamped):
`empty_response`, `empty_timeout`, `stall_timeout`, and `provider_error`
whose text is connection/5xx-shaped (`Connection error`, `ECONNREFUSED`,
`ECONNRESET`, `fetch failed`, HTTP 5xx, upstream-unavailable).

Does **not** count:
- rate limits / quota messages (a parsed reset time wins — the existing
  rate-limit path owns them; a subscription window running out is *not* a
  wedge),
- per-model request/shape errors (400/404/422 — ADR-0008 `request` or
  `permanent` verdicts),
- user aborts, `context_overflow`, `truncated_length`,
- candidates skipped before a request was made.

Classification reuses `error-signatures.ts` verdicts — no second error
taxonomy.

### D2 — Trip rule

`≥ N` **distinct** models of one provider with evidence inside window `W`
and no success of that provider in between ⇒ open for cooldown `C₁`.
Defaults (config key `provider_breaker`, see D8): cloud `N = 3`, local
`N = 2` (today's value), `W = 10 min`. Rationale for cloud `N = 3`: the
evidence shows cascades of 4–6 distinct models within 60 s, so 3 is safe
against one flaky model, and a provider with only two candidates in a group
is protected by D4 (never dead-end) rather than by a lower threshold.

### D3 — Intra-walk short-circuit (the immediate win)

The trip is evaluated **during** a candidate walk, not only across requests:
as soon as the third distinct model of a provider fails inside one walk, the
remaining candidates of that provider are skipped for the rest of *that*
walk. For timeouts this saves minutes in the very request that discovers the
wedge (defaults: 30 s first-token, 90 s for reasoning models, 180 s mid-stream
stall — `router-defaults.yaml`); the 4-in-16-ms cascade above shows the
shape even when failures are instant.

### D4 — Never dead-end

If every remaining attemptable candidate sits behind an open breaker, do not
fail. Pick the candidate of the breaker with the **soonest expiry** and
treat it as a forced half-open probe (same idea as the existing total
cooldown collapse, but for breaker skips — closing the gap found above). The
walk's error aggregation labels the attempt "probing wedged provider".
Result: a breaker can only ever *reorder and delay* attempts, never remove
the last option.

### D5 — State machine

`closed → open(until) → half-open → closed | open(escalated)`.

- Cooldown schedule on repeated trips without an intervening close:
  `C = [2, 5, 15] min` (capped), reset by a success. (Local keeps `5 min`
  flat unless the owner wants the same ladder — Q2.)
- **Half-open** = after `until` passes, the *first* request routes **one**
  candidate of that provider (the highest ranked) as the probe; others stay
  skipped until it succeeds. Success closes and clears evidence; failure
  re-opens with the next ladder step.
- Any success of any model of the provider closes the breaker immediately
  (existing `recordLocalSuccess` semantics, generalized).

### D6 — Visibility

- First open per provider: one narration line in the chat and the log:
  provider, evidence (e.g. "4 models returned empty responses within 40 s"),
  cooldown, and a **generic** fix hint (`wedgeFixHint` generalized: local →
  restart the daemon; cloud → "check the provider/extension, reload the
  session"). No provider-specific advice in code.
- `/router` overview: line per open breaker with remaining time (extend the
  existing wedge line, `commands.ts` ≈ line 473). Counters: trips and
  avoided hops per provider this session.
- `/router cooldowns clear` also clears breakers (incident relief without a
  restart — same contract as for model cooldowns).

### D7 — Persistence across restart (answer to "survives a restart?")

Breaker **state is volatile**; breaker **telemetry is persisted**.
- Reason: a restart is the standard remedy for a wedged extension (e.g. a
  bridge daemon stuck after a load-order race). If the open state survived
  the restart, the owner would have fixed the problem and the router would
  still skip the provider for the remaining cooldown — the worst moment to
  be stale.
- Implementation constraint (existing rule): state lives in the **cache
  object**, not in module variables (esbuild bundles some modules twice —
  `model-health.ts` header). Therefore a cache key that is *stripped on save
  and ignored on load/merge* (same mechanism family as the instance-scoped
  keys in `cache.ts`), not a module-level `Map`.
- Persisted: a small `provider_breaker_stats` (trips, last trip time,
  avoided hops per provider) so the evidence for tuning survives restarts.
- Consequence for ADR-0016: its local watchdog moves to the same volatile
  rule; today it persists with the cache (inaccurately documented as
  "restart starts clean"). One rule for both.
- Contrast: the learned **blocklist** (ADR-0008, permanent failures) stays
  persisted — a different class, deliberately long-lived.

### D8 — Config and ADR-0025 alignment

```jsonc
"provider_breaker": {
  "enabled": true,
  "min_models": { "cloud": 3, "local": 2 },
  "window_s": 600,
  "cooldown_s": [120, 300, 900]
}
```
Defaults live in code with the shipped config carrying no provider entries;
per-provider overrides (`providers.<id>.breaker`) only in the user layer.
Locality comes from `PROVIDER_MAP[p].local` (ADR-0025 class A). A kill
switch (`enabled: false`) restores today's behaviour exactly.

### D9 — Module shape

New `src/provider-breaker.ts` generalizing `provider-watchdog.ts`
(keep the exported names the orchestrator and `/router` already use as thin
re-exports during migration; delete the old file in the final phase). One
`recordProviderFailure(cache, ref, kind, now)` / `recordProviderSuccess` /
`breakerState(cache, provider, now)` API with injected clock for tests.

## Phases (each red-first, own commits, one PR per phase or batched per §5)

### Phase 1 — Core module + local parity (no behaviour change for cloud)
- `provider-breaker.ts` with D1 evidence classification, D2 trip rule, D5
  state machine, injected clock; `provider-watchdog` re-exports.
- **Red-first:** the existing `test/provider-watchdog*.test.ts` suite must
  stay green against the new module (parity pins); new unit tests: distinct
  models required, window expiry, success closes, escalation ladder,
  half-open single probe, per-provider isolation, evidence-class filter
  (rate limit and 400/422 never count).

### Phase 2 — Orchestrator wiring + never-dead-end
- Observe after every soft failure with the D1 evidence kinds (not only
  local timeouts); pre-flight skip for any provider (generalizing the two
  existing sites); **intra-walk short-circuit (D3)**; **D4 forced probe**.
- **Red-first (integration, mocked streams):**
  - 4 models of provider X return empty → third failure trips, 4th is
    skipped in the same walk, a provider Y candidate still answers;
  - *all* candidates belong to a tripped provider → forced half-open probe
    instead of "all candidates failed";
  - 400/422 errors from 3 models do **not** trip;
  - a rate-limit-shaped empty response (parsed reset) does **not** trip.

### Phase 3 — Visibility, volatile state, clear
- Narration, `/router` lines + counters, `/router cooldowns clear`
  integration, volatile cache key (stripped on save, ignored on merge) +
  persisted stats, ADR-0016 correction.
- **Red-first:** state absent after a save/load round trip while stats
  persist; clear command closes breakers; narration emitted once per open.

### Phase 4 — Replay validation + docs
- Offline replay of the 2026-10-04 08:31 cascade and the 10-06 08:03 burst
  from `router.log` through the new module (fixtures, no live provider):
  report avoided hops and false trips over the whole 6-day log — gate: **no
  trip on the mistral 400/422 days**, trips on every bridge cascade.
- ADR-0026 (accepted on merge) generalizing ADR-0016, README `/router`
  section, CHANGELOG entry (1.7.0), TODO.md tick.
- Full-range review per §1 before any release is proposed.

## Risks

| Risk | Mitigation |
|---|---|
| False trip on a healthy provider (flaky free tier: 3 empties in 10 min) | `N=3` distinct models, evidence-class filter, escalating-but-short cooldowns, D4 never dead-ends, kill switch; replay gate in Phase 4 |
| Breaker masks a real *quota* window (subscription out of capacity) | rate-limit/reset-time path wins and is excluded from evidence (D1) |
| Subscription providers where one empty response is normal for some models | distinct-model threshold + success-closes; tuned via the replay |
| Stale state after fixing the cause | D7: volatile across restarts + `/router cooldowns clear` |

## Open questions for the owner

1. **Q1 — scope:** one generalized mechanism (recommended: one rule, one
   code path, closes the Ollama `Connection error` gap) versus a separate
   cloud-only breaker next to the local watchdog?
2. **Q2 — cooldown ladder:** `[2, 5, 15] min` for cloud and keep local flat
   at 5 min, or the same ladder for both?
3. **Q3 — auth failures:** should 401/402 (revoked key, billing) on ≥ N
   models of a provider also open the breaker (different narration: "key
   rejected — fix it in Pi's auth")? Today they are classified transient and
   only per-model backoff applies.
4. **Q4 — volatile state:** confirm the D7 reasoning (restart clears the
   breaker; stats persist) — the alternative is a persisted state with a
   `process_epoch` check, which I consider over-engineered for a ≤ 15 min
   cooldown.
