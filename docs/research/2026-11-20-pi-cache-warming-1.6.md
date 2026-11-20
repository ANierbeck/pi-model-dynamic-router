# Pi 1.6.0 cache warming vs. router group models

**Status:** research note. Owner decision 2026-11-20: the user's Pi setting must be honored — Option A is rejected; follow-up plan [`2026-11-20-honor-pi-cache-warming.md`](../plans/2026-11-20-honor-pi-cache-warming.md) (pass-through to Pi's warmer instead of Option B/C). The recommendation below is
superseded by that plan: implemented 2026-11-20 as Option B plus the missing piece B
lacked — Pi's warm requests are recognized and pinned to the model that served the
session's last request.
**Verified against:** pi-coding-agent 1.6.0 (`dist/core/cache-warmer.js`,
`dist/core/sdk.js`, `docs/settings.md`, `docs/extensions.md`); repo `main` @ fbb8e93.

## What Pi does

- Pi 1.6.0 keeps provider prompt caches warm with a one-token request
  (`CacheWarmer`, `cache-warmer.js`). Setting `cacheWarming`: `"idle"` is the
  default; `"idle"` keeps caches warm up to 30 minutes between runs
  (`docs/settings.md`).
- Wiring (`sdk.js`): `cacheWarmer.start({ model, context, options })` runs only for
  requests with the session's own `sessionId`. Each refresh calls
  `modelRuntime.streamSimple(run.model, run.context, …)` with `maxTokens: 1` — the
  **agent's model**, not the model that actually answered.
- Start gates: the model must declare `promptCache` lifetimes
  (`getPromptCacheTtlMs`), and `evaluateCacheWarming` needs non-zero cost
  (`model.cost`) to find an expected saving above $0.05.
- Extension hook: `cache_warming_decision` (`docs/extensions.md` ~L912). Returns
  `{ action: "warm" | "stop" }`; the last returning handler wins. It only fires
  after the start gates pass.
- Warm usage is stored as a `cache_warm` session entry, not as an assistant
  message, so anything that sums assistant `usage` (our footer, `/router cost`)
  does not see it.

## What that means for the router

The router's group models (`src/group-registration.ts`, `registerProvider`) carry
`cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` and no
`promptCache`. Checked with the real `CacheWarmer` class (script:
`/tmp/cw-check/check.mjs`, not in the repo, no network calls):

| Model shape | `status` |
|---|---|
| router group model (as registered) | `inactive — cache lifetime unavailable` |
| same, with a `promptCache` lifetime | `inactive — cache economics unavailable` (zero cost) |

**Consequence:** Pi's warming is off for every router session. It issues no extra
requests, so there is no runtime breakage from 1.6.0. It also gives us no benefit.

Warming would also not fit the router's design even if it were switched on:
the warm request would re-enter the router's `groupStream`, i.e. classification
and routing run again per warm. Routing can land on a different provider than
the one holding the cache, so the warm could refresh the wrong cache and bill the
wrong provider.

The 2026-10-05 session-file analysis (kept in the owner's notes, not yet in the
repo) found that many expensive misses followed pauses of 666–831 minutes. Pi's
idle warming stops at 30 minutes, so it would not have covered those gaps.

## Options

- **A — leave it off and document it (recommended now).** No code change. Say in
  the README that Pi's `cacheWarming` has no effect on router group sessions.
  Our own 5a/5b/5c signals (cache TTL, context share, cold idle) stay the
  mechanism.
- **B — give the group model the resolved model's `promptCache` and cost.** Pi
  would then warm, but through the router again (see above). Rejected unless warm
  requests can be pinned to the resolved real model.
- **C — our own keep-alive on the resolved model.** The router would send its own
  one-token warm requests with `streamSimple` from `@earendil-works/pi-ai` (a
  public export) to the resolved model, with our own economics and TTL. This costs
  real cloud money per warm. It needs a plan (AGENTS §11) and an owner go. Gate it
  on measured misses within the 30-minute window first.
- **D — `cache_warming_decision` handler.** Only useful after B or C. Today it
  never fires for router sessions.

Recommendation: A now; C only as its own plan, after the measurement shows that
misses inside the 30-minute window are worth the warm cost.
