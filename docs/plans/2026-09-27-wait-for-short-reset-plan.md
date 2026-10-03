# Plan: Bounded Wait-for-Short-Reset (ADR-0017)

## Goal
When a rate limit has a **known, near reset**, the router should wait and retry the same model instead of burning the entire candidate chain. The total-cooldown collapse must no longer force-retry into known, unexpired cooldowns (self-poisoning). Immediate incident relief for the future: `/router cooldowns [clear]`.

## Background (incident 2026-09-27, 12:36–12:44 UTC)
Full reconstruction in ADR-0017. Short version: a 60s TPM window was ignored → the chain burned through → every subsequent request repeated it → the collapse branch force-retried into its own running cooldowns → cooldowns escalated beyond the provider's real recovery → the router stayed dead for minutes while the API had long been working again (proof: hard-pinning zai-glm-5-3 worked immediately).

## Implemented (as of 2026-09-27)

### 1. Config plumbing
- [x] `rate_limit_wait_max_ms` (default 120s, 0 = off): router-defaults.yaml, types.ts (defaults + Config), index.ts (`getRateLimitWaitMaxMs()`), stream-orchestrator ctx
- [x] `backoff_minutes` / `soft_backoff_ms` are now **cfg-backed** (previously they fell back to the YAML defaults only) — ops-tunable without a rebuild, and shrinkable in integration tests
- [x] **Dynamic-config whitelist extended**: `stall_timeout_ms`, `rate_limit_wait_max_ms`, `backoff_minutes`, `soft_backoff_ms` are now re-synced from staticCfg like `exclude`/the empty timeouts — without this, stale dynamic files (they exist after every scan!) would silently have shadowed user overrides. `stall_timeout_ms` was already missing from the whitelist (same bug find, boyscout)

### 2. Wait-for-short-reset (driveStream, rate_limit branch)
- [x] On `rate_limit_exceeded` with `resetAtMs` in (0, `rate_limit_wait_max_ms`]: narrate "waiting Ns, then retrying…", sleep until reset+2s, **retry the same model once**; success → done; another failure → record + "still failing" → normal cascade
- [x] At most **one** wait per driveStream invocation (`rateLimitWaitUsed`) — no livelocks
- [x] Key rotation (`rotated`) skips the wait (no cooldown on the ref)

### 3. Collapse-branch repair
- [x] `bestSecs * 1000 ≤ rate_limit_wait_max_ms` → **wait** (bestSecs+2s), then retry — no more force-retries into known, running cooldowns
- [x] Long remaining times: old immediate-retry semantics unchanged
- [x] Collapse narration moved from `pushRouterInfo` (invisible in router.log!) to `pushRouterInfoLogged`

### 4. `/router cooldowns [clear]`
- [x] `RateLimitManager.listLimits()` — active cooldowns (shortest first, hits, provider reset)
- [x] `RateLimitManager.clearAllLimits()` — all in-memory cooldowns
- [x] Handler: `cooldowns` shows cooldowns + model_health streaks; `cooldowns clear` clears cooldowns + `cache.model_health` (persisted!) + saveCache — **without restarting pi**

### 5. Tests
- [x] `test/rate-limit-wait.test.ts` (4 tests): wait-retry without burning the chain (Healthy is NEVER touched), far reset → no wait → normal cascade, collapse wait (shortest cooldown awaited, then success), listLimits/clearAllLimits
- [x] 13 affected legacy tests: explicit `rate_limit_wait_max_ms: 0` (they deliberately test the non-wait paths)
- [x] `npx tsc --noEmit` clean · suite **1026 passed** (+4)

### 6. Build & rollout
- [x] `npm run build`
- [ ] pi restart (loads the new bundle); afterwards hard-pinning zai-glm-5-3 is no longer needed — routing usable again; if necessary `/router cooldowns clear`

## Open (separate)
- ADR-0018 HINT repair (its own round; MHINT behavior during the incident window stood out — noted as input for the analysis)
- mistral-small-latest demotion (C step) — decision after the first new stopReason evidence

---
**Created:** 2026-09-27 · **Last change:** 2026-09-27 (translated to English
2026-09-30 per AGENTS.md §3) · **State:** Implemented 2026-09-27 (commit
`acf80eb` "wait for near rate-limit resets instead of burning the candidate
chain"; ADR-0017 documents the incident and the decision)
