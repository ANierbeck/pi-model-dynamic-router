# 0003 — Reject live subscription-usage-API querying

## Status

Rejected (2026-08-30).

## Context

The user's underlying goal: avoid the router repeatedly selecting an
expensive subscription model (Claude Sonnet 5 / Opus 5 via claude-bridge)
when that subscription's usage window is already close to exhausted,
instead of proactively favoring free/local/cheaper models before the
subscription actually rate-limits. The proposed mechanism was to query a
live "remaining subscription usage" API from Anthropic and Mistral at
session start (and periodically), reusing whichever credentials the router
already holds for those providers, and feed the result into the existing
budget-gating logic (`hasBudget()` in `src/budget.ts`).

An explicit constraint from the user going in: any such reuse of existing
provider keys must never let a key leak (into logs, error messages, or
third-party requests) — this was satisfied by construction regardless of
the outcome below, since the credentials in question are only ever passed
as an `Authorization`/`x-api-key` header directly to the provider's own
domain, the same way every other request in this router already works.

**What already existed before this ADR, unrelated to this investigation:**
`src/budget-tracker.ts` (added in commit `2330c54`, "feat: separate
subscription and token-based routing") already attempted exactly this —
`fetchClaudeBudget()` calling `https://api.anthropic.com/v1/user/usage`
and `fetchMistralBudget()` calling `https://api.mistral.ai/v1/usage`. On
inspection, both functions ignored their fetch response body entirely and
returned hardcoded placeholder numbers (`remaining_tokens: 50000` /
`1000000`, comment: "Conservative estimate for testing") regardless of
what the endpoint returned. The one code path that would have invoked
these live (`filterByBudgetAsync()` in `src/routing.ts`) was never called
from anywhere in the routing decision path — only the synchronous,
cache-only `filterByBudget()` was wired into `resolveGroup()`. Additionally,
`refreshBudgets()` (the session-start/5-minute-interval caller in
`index.ts`) only iterates providers where `cfg.providers[prov].billing ===
'subscription'` is explicitly set in `router-config.json` — neither the
checked-in config nor the user's personal override
(`~/.pi/agent/router-config.user.json`) sets this for `anthropic` or
`mistral`, so in the user's actual running config this loop was always
empty. Net effect: a plausible-looking, fully wired class that never
executed its own core logic in practice, and returned fabricated numbers
on the rare path where it might have. This predates the current
investigation and was not something introduced while evaluating this ADR
— see the "Cleanup" section below for what was done about it.

## Decision Drivers

- **The credential-reuse question is moot if there is nothing to query.**
  Before designing key-reuse/leak-prevention mechanics, the investigation
  first had to confirm a queryable endpoint actually exists for each
  provider's *subscription* tier specifically (as opposed to pay-per-token
  API billing, which is a different product with different APIs).
- **claude-bridge (the actual credential path for the user's Claude
  subscription) is deliberately outside the router's credential
  management.** `claude-bridge` is listed in `SKIP_REGISTRATION`
  (`src/providers.ts`) specifically because it's an externally-installed
  Pi extension that manages its own OAuth session; the router never
  discovers or holds a key for it. There is no key belonging to
  claude-bridge for the router to reuse in the first place — reuse is not
  merely inadvisable here, there is nothing present to reuse.
- **`anthropic` in `PROVIDER_MAP` is a separate, legacy pay-as-you-go
  provider**, not the Pro/Max subscription the user is on. Even if a key
  were configured for it, querying its usage would answer a different
  question than the one being asked ("how much of my Claude Code Pro/Max
  usage window is left").
- **Mistral is already configured as `pay_per_token` billing in this
  router** (`src/providers.ts`), not `subscription`. The existing
  `hasBudget()` rule already treats pay-per-token providers as always
  having budget — a Mistral usage check would never change a routing
  decision under the current billing classification, independent of
  whether the API exists.
- **Non-vacuous verification discipline** (`AGENTS.md` §4) applies to
  research claims the same way it applies to tests: a design built on an
  assumed-but-unverified API is exactly the kind of thing that looks done
  but isn't, which this project has been burned by before (roborev job
  308, and now this pre-existing stub).

## Options Considered

### A — Build a real live-usage fetcher against Anthropic/Mistral APIs (rejected)

Fix `fetchClaudeBudget`/`fetchMistralBudget` to actually parse their
response bodies and wire `filterByBudgetAsync` into the real resolution
path.

- **Pros:** Would be the most direct, proactive answer to the user's
  stated goal, if the underlying data existed.
- **Cons — this is why it's rejected:**
  - Anthropic's own documentation for Claude Code
    (`support.claude.com` — "Models, usage, and limits in Claude Code")
    explicitly scopes the only usage-reporting mechanism it documents
    (the `/cost` command) to **API billing only**: *"If you are using an
    API key, the `/cost` command shows your running spend for the current
    session."* There is no equivalent documented for subscription
    (Pro/Max) sign-in — not in the CLI, and no public API endpoint was
    found that reports remaining Pro/Max 5-hour or weekly window usage.
    `https://api.anthropic.com/v1/user/usage`, the endpoint the existing
    stub guesses at, does not appear in Anthropic's public API reference
    for this purpose.
  - Mistral's admin usage/billing documentation
    (`docs.mistral.ai/admin/billing-usage/usage-limits`) did not surface
    a queryable "remaining quota" endpoint reachable with a normal API
    key either.
  - Even if such an endpoint existed for Anthropic, `claude-bridge` (the
    actual credential path in use) is out of the router's reach by
    design (see Decision Drivers) — there is no key to call it with.
  - Building this against an undocumented/guessed endpoint risks exactly
    the failure mode the original stub already fell into: code that looks
    like it works, silently returns wrong or fabricated numbers, and
    gates real routing decisions on them.

### B — Rely on existing reactive rate-limit detection (accepted)

Keep using what already exists and works: the router detects rate-limit
*error messages* from claude-bridge at request time (`CLAUDE.md`:
"Warning: `[rate-limit]` Claude five_hour rate limit hit", "You've hit your
monthly spend limit", etc.), treats them as soft failures via
`RateLimitManager` (`src/rate-limit.ts`), and falls back to the next
candidate with an escalating cooldown. This is reactive rather than
predictive — it only reacts once a limit is actually hit rather than
avoiding it in advance — but it requires no unavailable API and no new
credential handling.

- **Pros:** Already built, already tested (`test/rate-limit-cooldown.test.ts`,
  `test/cooldown-collapse.test.ts`), needs zero new code. Correctly scoped
  to information that is actually observable (an error the provider
  itself sent), rather than information that isn't exposed anywhere.
- **Cons:** Cannot avoid the *first* request that hits the limit in each
  window — some cost/latency is spent discovering the limit rather than
  anticipating it. Given Option A is not achievable, this is an accepted
  limitation, not a design trade-off.

### C — Parse local usage logs instead of querying a live API (deferred, not rejected)

Tools like the community "CodexBar" app the user already uses apparently
derive usage summaries by reading Claude Code's/Codex's local session or
transcript files on disk, rather than calling any live quota API (which,
per Option A, likely doesn't exist for this purpose). The router could in
principle do something similar: read local session/transcript state that
Claude Code (via claude-bridge) already writes, and use recent local token
throughput as a heuristic for "probably close to the window limit," without
querying any external API or holding any credential at all.

- **Pros:** Needs no credential of any kind, so the leak-prevention
  constraint from the original ask becomes fully moot — there's no key in
  the picture. Could offer earlier warning than the purely reactive
  Option B, if local log format and location can be relied upon.
- **Cons — why this is deferred rather than pursued now:** Depends on an
  undocumented, extension-owned, potentially-unstable local file format
  and path (owned by claude-bridge / Claude Code CLI, not this project) —
  a much less stable foundation than a documented public API would have
  been, and prone to silently breaking on an unrelated claude-bridge
  update. It also reopens the same category of question ADR 0002 already
  worked through for a different feature: reading and retaining
  local usage/session data is a new class of data handling this project
  hasn't done, and deserves the same deliberate opt-in treatment given to
  `classifier_cloud_fallback` (see `[[0002-learning-from-user-feedback]]`),
  not an implicit addition bundled into this rejection.

## Decision

**Rejected: proactive live-usage-API querying (Option A) is not adopted,
because the API it would depend on does not appear to exist for the
subscription tier in question** (Claude Pro/Max via claude-bridge), and is
architecturally unreachable regardless (claude-bridge credentials are
intentionally outside the router's management). Mistral is unaffected
either way since it's already billed as pay-per-token in this router,
where the existing rule already treats it as always-available.

**Accepted (already in place): Option B**, the existing reactive
rate-limit-error detection and cooldown escalation in
`src/rate-limit.ts`, remains the mechanism for this problem. No new code
was needed to "accept" this — it already covers the case correctly, just
reactively instead of predictively.

**Deferred: Option C** (local usage-log parsing) is recorded here as a
real, distinct alternative — worth a dedicated ADR of its own if pursued,
given it raises its own data-retention question independent of this one.
Not accepted now. Good trigger to revisit: if the reactive cooldown in
Option B proves too slow in practice (subscription bill/window genuinely
gets exhausted before the first rate-limit error arrives, e.g. due to a
sudden burst of large requests) — and only after checking whether
claude-bridge or the Claude Code CLI itself has since shipped a
documented local-usage or live-usage interface, since this ADR's
"no such API exists today" finding could become outdated.

## Consequences

- `src/budget-tracker.ts` (the pre-existing, never-actually-executing stub
  with hardcoded fake usage numbers) is deleted, along with all of its
  wiring: `budgetTracker` instantiation/refresh calls and the 5-minute
  refresh interval in `index.ts`, the `budgetTracker` field and
  `filterByBudgetAsync()` (which was dead code — never called) in
  `src/routing.ts`.
- `hasBudget()`/`filterByBudget()` in `src/budget.ts` and the
  `Cache.budget_cache` field in `src/types.ts` are kept as-is — they are
  sound, tested (`test/budget.test.ts`), and provider-agnostic. They
  simply have no live writer now (`budget_cache` stays empty in practice),
  which correctly falls through to "assume available," the same as a
  pay-per-token provider. This is intentionally left as the hook a future
  Option-C-style local tracker could populate, without needing to touch
  the gating logic itself.
- No change to `router-config.json` or `router-defaults.yaml` — nothing
  there referenced the removed code.
- If this idea resurfaces (per the user's explicit ask, likely in 2-3
  months): the answer is in this file. Start by checking whether Option
  A's premise ("no such API exists") is still true before re-deriving
  anything — Anthropic/Mistral may ship one later.
