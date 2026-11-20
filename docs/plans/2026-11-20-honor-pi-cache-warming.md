# Honor Pi's `cacheWarming` setting in router sessions

**Status:** proposed 2026-11-20 — awaiting owner approval.

**Verified against:** pi-coding-agent 1.6.0 (`dist/core/cache-warmer.js`,
`dist/core/sdk.js` L192/L213–223/L262–271, `dist/core/agent-session.js`
L2837–2846/L2954–2972, `dist/core/session-manager.js` L885–897,
`pi-ai/dist/cache-warming.js` L49, `docs/settings.md`, `docs/extensions.md` ~L912);
repo `main` @ 79bfae4 (`src/group-registration.ts` L192–222,
`src/context-compaction.ts` L271–290, `src/routing.ts` L480/L679). Measured with
the real `CacheWarmer` class (no network); see
[`docs/research/2026-11-20-pi-cache-warming-1.6.md`](../research/2026-11-20-pi-cache-warming-1.6.md).

## Problem

Pi 1.6.0 keeps prompt caches warm according to the user's `cacheWarming` setting
(`off` / `streaming` / `idle`, default `idle`). In a router session that setting is
silently ignored: the router's group models declare no `promptCache` lifetime and
zero cost, so Pi's `CacheWarmer` stops at its start gate
(`cache lifetime unavailable`). A user who configures — or relies on the default
of — Pi's warming gets different behavior as soon as the router is active. The
router must not override a Pi setting the user chose.

## Solution — pass through to Pi's own warmer (no re-implementation)

Pi's warmer stays the single owner of *when* to warm: the user's mode, the
30-minute idle and one-hour limits, the $0.05 economics, the
`cache_warming_decision` hook, `/session` status and the `Cache warmed: $…`
notice all keep working unchanged. The router supplies only what Pi cannot know
about a virtual model.

1. **Declare the cache economics of the resolved model on the group model.**
   After a stream resolves, re-register the session's group provider (a provider
   the router owns — AGENTS §6 Ü1 guard unaffected) with the resolved model's
   `promptCache` and `cost`. Pi refreshes the session's model from the registry
   after `registerProvider` (`_refreshCurrentModelFromRegistry`), so the next
   request's `cacheWarmer.start()` sees them. Re-register only when the
   declared economics change. Mirror Pi's replay gate: when the resolved model is
   `anthropic-messages` without `compat.forceAdaptiveThinking` and the session
   thinks (`reasoning` set), declare no `promptCache` — Pi would not warm it
   natively either (the group model's own `api` cannot express this).
   Pin that the declared group cost cannot leak into ranking
   (`isVirtualGroupRef` already filters virtual refs from candidate pools).
2. **Serve Pi's warm request verbatim on the session's turn model.** Pi's warm is
   a `streamSimple` call on the group model with the cached context and
   `getCacheWarmingRequestOptions()` — `maxTokens: 1`, `disableContinuation: true`,
   `maxRetries: 0`. `disableContinuation` is set by nothing else in Pi 1.6.0, so
   `groupStream` recognises the warm by that triple and forwards it to the
   session's current turn model through the same request path as the real
   request (same prefix), with **no** classification, fallback walk, breaker
   evidence, blocklist write or decision-log record. If there is no turn model,
   or it is unavailable (limited, breaker open), the warm returns an error
   message: no fallback — warming a different provider's cache is pointless and
   costs money. Pi records nothing for an error result.
3. **Keep 5b/5c consistent with warming.** The cold-cache signal
   (`lastStepCacheState`, `isCacheCold`, `idleSeconds`) treats the latest
   successful Pi warm (session `usage` entry, `kind: "cache_warm"`) like a step,
   so compaction (5b) never discards a cache Pi kept warm and the fresh-session
   suggestion (5c) does not claim "cache went cold from idling".
4. **Docs.** Replace the README "no effect" line; mark the research note's
   recommendation as superseded by this plan; CHANGELOG.
5. **Live check** (owner session): `/session` in a router session shows a warming
   decision instead of `cache lifetime unavailable`; a warm shows
   `Cache warmed: $…` and lands on the turn model's provider.

Each step red-first (AGENTS §4); one PR.

## Open decisions

- **O1 — warm costs in `/router cost`.** Pi counts warms in its own session totals
  (`cache_warm` usage entries). Should the router's usage log also record them, as
  a separate kind so turn statistics stay clean? Recommendation: yes, separate
  kind, shown as its own line.
- **O2 — your own sessions.** Pi's default is `idle`, and your Pi settings set no
  `cacheWarming`. Once this ships, your router sessions start warming (billed at
  list price on PAYG; on subscriptions it consumes the token allowance). If you do
  not want that, set `"cacheWarming": "streaming"` or `"off"` in Pi's global
  settings — that is the point of honoring the setting.
- **O3 — in-process sub-sessions.** Group providers are process-wide; two sessions
  of one group resolved to different models in the same process overwrite each
  other's declared economics (TTL/cost used by Pi's decision). The warm itself
  still goes to each session's own turn model. Recommendation: accept and document;
  revisit only if measured.

## Not in scope

- A router-side keep-alive with its own timer and economics (rejected: duplicates
  Pi and could diverge from the user's setting).
- Warming across the 30-minute idle limit (Pi's limit, not ours).
