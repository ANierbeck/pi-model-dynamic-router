# External usage source: provider quota and balance from CodexBar (optional)

**Status:** proposed 2026-11-08 — not started. Optional extension; the owner implements it when convenient. Builds on the integration contract of [`2026-11-08-optional-integrations-config.md`](2026-11-08-optional-integrations-config.md) (config block, validation, health, status line); that plan should land first or together with step 2 below.

## Problem

The router only sees its own counters. It cannot tell how much of a provider's quota or balance is left until a request fails:

1. **Budget pacing runs on self-counted numbers against a hand-written allowance.** `src/budget-pacing.ts` compares the router's own `usage_log` token sum (or tokens × blended `effCost` for `unit: 'usd'`) with a LINEAR target derived from the user-declared `providers.<p>.budget {amount, unit, period: 'month', reset_day}`. The provider's real window (Claude 5-hour session / weekly, OpenRouter key cap and reset) and real reset time are unknown; the allowance has to be typed in by the user and kept current by hand.
2. **`budget_cache` is always empty.** `src/budget.ts` header: no live refresh path exists, `hasBudget()` reads `cache.budget_cache` (always empty), so every subscription provider counts as available, and only `RateLimitManager` reacts — after a provider has already rejected a request (ADR-0003, Option B accepted).
3. **Pay-per-token balances are not seen.** An OpenRouter account with an empty prepaid balance, or a key that has reached its spending cap, looks exactly like a healthy one until the first error.
4. **ADR-0003 deferred exactly this.** Option C ("parse local usage logs … tools like the community CodexBar app") was deferred, not rejected, and "worth a dedicated ADR of its own if pursued". Its Option A rejection still stands: the router must not call undocumented quota endpoints itself and does not hold the claude-bridge credentials (ADR-0022).

Consequence: the first request into an exhausted window is always spent discovering the limit, and the user maintains budget numbers that the providers already know.

## Solution

Read quota, pace and balance from a locally running [CodexBar](https://github.com/steipete/CodexBar) as an **optional, read-only, loopback-only evidence source**. CodexBar owns all credentials and provider-specific fetching; the router only reads aggregated percentages, reset times and balances over HTTP on `127.0.0.1`. Absent, disabled or unreachable CodexBar means behaviour identical to today.

1. **New ADR (next free number)** — "External usage sources are optional, read-only, loopback-only routing evidence". It cites ADR-0003 (Option C, and Option A's reasons for not querying providers directly) and ADR-0022 (the router never handles credentials). ADR-0003 is not edited (AGENTS.md §12).
2. **Transport: `codexbar serve` on loopback, background poll only.**
   - `GET http://127.0.0.1:<port>/usage?provider=<id>`: unauthenticated on loopback by CodexBar's design, so the router holds no token. `GET /health` returns the running `version`, which goes into the health state.
   - A background timer polls (default 120 s, minimum 60 s; CodexBar's own cache default is 60 s). The request path never waits on CodexBar: routing reads only the last snapshot in memory.
   - A snapshot older than `stale_after_s` (default 600) counts as absent. Repeated poll failures back off on a ladder, so a stopped CodexBar does not log once per tick.
   - Never spawn the `codexbar` CLI per request; one-shot `usage` fetches can take up to 60 s.
3. **Provider-neutral adapter.** `src/external-usage.ts` defines the type the router consumes: `ProviderQuotaSnapshot { provider, windows[{ kind: 'session' | 'weekly' | 'other', usedPercent, resetsAt, windowMinutes }], pace?{ willLastToReset, etaSeconds }, balance?{ remaining, currency }, keyLimit?{ remaining }, fetchedAt, source }`. `src/external-usage-codexbar.ts` maps CodexBar's `usage` JSON onto it. A second source (for example a provider's own documented API) would be another adapter, not a change to routing.
4. **Identity never enters the router.** The parser drops `identity`, `accountEmail`, `accountOrganization`, `loginMethod` and `openaiDashboard`, so nothing identifying is cached, logged or put in the decision log. Only numbers and timestamps are kept.
5. **Provider id mapping is configuration, not code.** CodexBar ids (`claude`, `openrouter`, `mistral`, …) map onto router provider names through a config table (`provider_map`), for example `claude` → the provider name claude-bridge registers. Nothing names a model (AGENTS.md §9 / ADR-0025).
6. **Effects are staged, each behind its own mode**, following the Laya pattern of shadow first:
   - **observe** (default when enabled): the snapshot shows up in `/router status` and as an `external_usage` field in the decision log. No routing effect.
   - **pace**: for a provider with a fresh snapshot, `willLastToReset === false`, or a `usedPercent` ahead of the linear target for that window, demotes the provider through the existing `pacedProviders()` path. It is a rank penalty, never an exclusion. Without a snapshot the own-counter pacing applies unchanged.
   - **exhausted**: a window at `usedPercent >= 100` before its `resetsAt`, or `balance.remaining <= 0`, books a known-reset cooldown in `RateLimitManager` until `resetsAt`. That reuses the bounded wait-for-short-reset logic (ADR-0017) and adds no new exclusion path.
7. **No double counting.** CodexBar's `pi` provider and `codexbar cost` re-count the same Pi sessions the router already books in `usage_log`. They are not used for routing; at most `/router cost` shows them next to the router's own figures as a cross-check (optional, last step).
8. **Version guard.** The adapter is tested against a recorded, anonymised fixture from a pinned CodexBar version. A `/health` version with a different major logs one warning and keeps parsing defensively: unknown fields are ignored, and a missing required field drops the snapshot rather than guessing.

## Open decisions

1. **Who runs `codexbar serve`?** (a) The CodexBar app's own managed HTTP server (Settings → Advanced → HTTP server; the app must run anyway for browser-cookie and Keychain providers). (b) A launchd agent. (c) The router spawns it as a child process. Recommendation: (a). The router stays a pure HTTP consumer, as with the Laya sidecar.
2. **Providers in v1.** Candidates: `claude` (subscription windows, the most value), `openrouter` (balance and key cap), `mistral` (CodexBar reads it through browser cookies), `codex`. Recommendation: `claude` + `openrouter` first.
3. **Replace or complement own-counter pacing?** Recommendation: complement. A fresh snapshot wins for that provider's window; otherwise the own counter applies. `providers.<p>.budget` stays the user's explicit override.
4. **Does `exhausted` book a cooldown, or only demote?** A cooldown is stronger (the provider is skipped until reset) and relies on CodexBar being right. Recommendation: ship `observe` → `pace` first and decide `exhausted` from observed data (`docs/research/`).
5. **Mistral billing class.** The router classifies Mistral as `pay_per_token` (ADR-0003), so `hasBudget()` always passes it. Should a known zero balance still count as `exhausted`?
6. **Exporting to the Pi / Grafana** (`codexbar dashboard --output <file>`, an atomic JSON file) is out of scope here; it would get its own plan if wanted.

## Verified against

Commit `a9dc015` (`main`, 2026-11-08): `src/budget.ts`, `src/budget-pacing.ts`, `src/routing.ts` (`pacedProviders` call sites at lines 1155/1307/1345, `filterByBudget` at 1227), `src/cost-tracker.ts`, `src/types.ts` (`ProviderConfig.budget`, `ClassifierLayaConfig`), `src/config-loader.ts` (`validateClassifierLaya` loopback check), `docs/adr/0003-reject-live-subscription-usage-api.md` (Options A/B/C). CodexBar docs on `steipete/CodexBar` `main`, fetched 2026-11-08: `docs/cli.md` (`serve`, `guard`, `hooks watch`, usage and cost JSON, exit codes), `docs/dashboard-api.md`, `docs/openrouter.md`, `docs/pi.md`. On the owner's Mac: CodexBar app 0.84.0 in `/Applications`, CLI helper `Contents/Helpers/CodexBarCLI` present but not linked onto `PATH`, `~/.config/codexbar/` exists (contents not read).

**Not checked:** real `usage` JSON from the installed 0.84.0 (the CLI was not run, to avoid Keychain prompts); whether the 0.84.0 app already has the managed HTTP-server setting; the CodexBar Mistral and Claude provider docs; which provider name claude-bridge registers on this machine; CodexBar's behaviour inside a headless Linux environment (no browser cookies there).

## Steps

- [ ] Owner decides 1–3 (4 and 5 can wait for observe data).
- [ ] ADR "External usage sources are optional, read-only, loopback-only routing evidence" (cites ADR-0003, ADR-0022).
- [ ] Record one real, anonymised `/usage` response per v1 provider as test fixtures (owner runs the CLI; fixture reviewed for identity fields before commit).
- [ ] Red-first: adapter contract tests (mapping, identity stripping, unknown fields, missing required field → no snapshot, stale snapshot → absent, non-loopback endpoint → integration disabled).
- [ ] Adapter + background poller + health state via the integration contract (other plan); mode `observe` only; `/router status` line; decision-log field.
- [ ] Invariant test: disabled / unreachable / timed-out CodexBar yields routing identical to today.
- [ ] Mode `pace` wired into `pacedProviders()`, with tests next to the existing budget-pacing tests.
- [ ] Observation period; findings to `docs/research/`; owner decides on `exhausted`.
- [ ] Docs: `docs/config-override.md` section and README "optional integrations".
