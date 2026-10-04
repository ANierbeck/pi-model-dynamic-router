# ADR-0017: Bounded Wait-for-Short-Reset instead of Burning the Candidate Chain

## Status
Accepted (2026-09-27) — replaces the first draft ("Explicit reset time in the narration"), which misread the problem: the absolute reset time was already being displayed (`formatResetMsg` renders "(resets 27.9.2026, 14:37:11)"). Achim's request was to make the router actually WAIT for such short resets — configurable — not to change the display.

## Context / Incident (2026-09-27, 12:36–12:44 UTC)

Observed chain (fully reconstructed from router.log):

1. **12:36:11 UTC** — `zai-glm-5-3` hits a real Mistral TPM limit with a known, short reset: "resets 27.9.2026, 14:37:11" — **60 seconds**. (14:37:11 is the provider's local-time reset rendering — Europe/Berlin CEST in this case, i.e. 12:37:11 UTC — the two timestamps are the same instant, not 2 hours apart.) All Mistral models share the account-wide TPM; the subsequent candidates report the same +60s pattern (14:37:14, :17, :21).
2. The router cascades **immediately** through all candidates instead of waiting 60s. Each candidate gets a failure record (422 → "likely rate limit", rate limits, empty responses).
3. The running agent turn fires many tool-call requests in a row → **every request burns the whole chain again** → 2 failures / 15 min per model → escalating backoffs.
4. **12:37:11** — zai is really available again (TPM window elapsed). The router doesn't notice: the cascade keeps running.
5. **Total-cooldown-collapse branch**: "Force-retrying X (**28s remaining**)" — retrying **into a known, unexpired cooldown** → guaranteed failure → **a new failure record** → backoff doubles → the cooldown extends beyond the real recovery (**self-poisoning**).
6. **12:43:58** — Total collapse: all 17–18 candidates across all 10 groups locked. The router stays dead for minutes although the API has long been working again.
7. **Proof of divergence**: Achim hard-pins the model to zai-glm-5-3 (bypassing router state) → **works immediately**. Router state had decoupled from reality.

## Decision

**1. Bounded wait-for-short-reset (driveStream, rate_limit branch):**
When a candidate fails with `rate_limit_exceeded`, `resetAtMs` is known, and `resetAtMs − now ≤ rate_limit_wait_max_ms` (default 120s, 0 = off):
- Stop the cascade, narrate "rate limited (resets …) — waiting Ns, then retrying…"
- Sleep until `resetAtMs + 2s`, retry the **same model once**
- Success → done; another failure → continue the cascade normally
- **At most one wait per driveStream invocation** (`rateLimitWaitUsed`) — no livelock risk

**2. Collapse-branch repair (ending the self-poisoning):**
In the total-cooldown collapse: if the shortest remaining time `bestSecs ≤ rate_limit_wait_max_ms` → **wait** (`bestSecs + 2s`), then retry. No more force-retries into known, unexpired cooldowns (every such retry produced a guaranteed failure and extended the cooldown — the escalation spiral). Long remaining times keep the old immediate-retry semantics. The narration also moved from `pushRouterInfo` (invisible in the log!) to `pushRouterInfoLogged`.

**3. `/router cooldowns [clear]` (immediate incident relief):**
- `/router cooldowns` — lists active cooldowns (ref, remaining seconds, hits, provider reset) + model_health streaks
- `/router cooldowns clear` — clears ALL in-memory cooldowns + `cache.model_health` streaks (persisted), without restarting pi. For future incidents: one command instead of a restart.

## Consequences
- **Positive:** Short TPM windows (60s) cost a narrated pause instead of a total collapse; the flood of failures onto 17 uninvolved models disappears; router state can no longer poison itself; manual recovery without a restart.
- **Negative:** During the wait window (≤120s) the stream stalls (narrated). An abort during the wait only takes effect after it elapses (no abort plumbing in driveStream — accepted, bounded).
- **Neutral:** Cooldown backoffs and escalation stay unchanged for unlimited/unclear failures.

## Configuration
- `rate_limit_wait_max_ms` (router-defaults.yaml: 120000; overridable in router-config.json / user layer; `0` disables both wait paths)

## Implementation
- `src/stream-orchestrator.ts`: rate_limit branch (wait+retry), collapse branch (wait instead of immediate force-retry), `sleepMs` helper
- `src/rate-limit.ts`: `clearAllLimits()`, `listLimits()`
- `index.ts`: `getRateLimitWaitMaxMs()` getter, ctx wiring, `/router cooldowns [clear]`
- `src/types.ts`, `router-defaults.yaml`: `rate_limit_wait_max_ms`
- Tests: `test/rate-limit-wait.test.ts`

## Alternatives rejected
- **Only extend the narration** (first draft) — the reset time was already displayed; solves nothing.
- **Wait at the first rate limit without a threshold** — would block the turn forever on five-hour windows (2h+); hence bounded.
- **Lower the cooldown escalation** — fights the symptom, not the cause; the chain must not burn through in the first place.

## Related documents
- ADR-0008 (Learned Blocklist) — permanent provider defects
- ADR-0018 (HINT mechanism repair) — independent
- ADR-0014 (HINT channel and narration hygiene) — the channel that surfaced
  the reset-time narration quoted above
- `src/rate-limit.ts` — recordLimit (resetAtMs-aware), recordSoftFailure

---
**Created:** 2026-09-27 · **Last change:** 2026-09-27 (rewrite after a live incident; translated to English 2026-09-30 per AGENTS.md §3) · **State:** Accepted
