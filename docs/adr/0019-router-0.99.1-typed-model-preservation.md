# ADR-0019: Router 0.99.1 Hardening — Typed-Model-Preserving Re-Registration

## Status

Accepted (2026-09-30). **Superseded in part by ADR-0021 (2026-10-02)**: the
scan-union registration this ADR's round-trip machinery protected has been
removed — the router no longer registers scan-discovered models, so the
typed-model preservation round-trip is retired. This ADR's documentation of
Pi 0.99.1's layered registry composition remains valid and authoritative.

## Context

ADR-0005 documented Pi 0.87.1's `registerProvider` semantics: a registration **replaces** the provider's model list wholesale, and the router defends with Ü1-style guards (only register providers Pi does not know; round-trip pi-known models when a union is unavoidable).

Pi 0.99.1 replaced the flat registry with a **layered composition** (verified against the 0.99.1 tarballs):

- Each provider is composed from **builtin catalog + user `models.json` + extension overlay** (`ModelRuntime.composeProvider`, `dist/core/model-runtime.js:166-186`).
- `registerProvider` validates first (broken registrations throw without mutating), merges top-level fields with the previous *extension* registration (undefined keys preserved), and recomposes (`model-runtime.js:635-666`).
- If the extension config defines `models`, the composed model list is **only** the extension models (`applyExtension`, `dist/core/provider-composer.js:171-178`) — builtin and models.json entries drop out. The `images`/`classifiers` *implementation maps* survive, but the model entries do not.
- The builtin catalog now ships large **non-chat inventories under provider ids the router re-registers**: openrouter carries 398 chat + 57 image + 7 classifier models (462 total; jev family included); there is a classifier-only `typesafe` provider. (Count corrected 2026-09-30 from the shipped 0.99.1 catalog — an earlier draft said "53 image + 8 classifier".)
- **`getAll()` is chat-only** (roborev review round, HIGH — corrected from an earlier draft of this ADR): `ModelRegistry.getAll()` resolves to `runtime.getModels()`, whose per-provider `getModels()` filters `isModelType(m, "chat")` (`pi-ai dist/models.js:572`). Non-chat inventory is reachable ONLY via `getModelsOfType(type, provider)` / `findOfType(type, provider, id)` / `getAllModels()`, all present on the 0.99.1 `ModelRegistry`.
- `unregisterProvider` recomposes from builtin + models.json — a bad overlay is **reversible in-session**, unlike 0.87.1's destructive replace.

The router's scan-union re-registration (post-`b75b14f`) already round-trips pi-known models, but its field allow-list was **chat-only**: no `type`, `output`, `inputLimits`, or `promptCache` (and `samplingParams`). Because `getAll()` returns only chat models, a `getAll()`-sourced union would **silently drop the provider's non-chat models** from the recomposed list (openrouter: 57 image + 7 classifier wiped on every scan-triggered re-registration); and any non-chat model that DID survive the round-trip was re-registered **as a chat model** (corruption, e.g. an image model becoming chat-selectable).

## Decision Drivers

- Single-user deployment; the router must keep working through Pi upgrades and rollbacks (0.87.1 compatibility is rollback safety, not legacy support).
- Credentials in `auth.json` bind to **provider ids** — the router must not invent new provider ids for scan-discovered models.
- Scans are the router's core feature (cost discovery, FREE models); suppressing them is not an option.
- The composition is re-runnable and recoverable; the design should exploit that (read composed state, re-register the full desired state).

## Options Considered

1. **Typed full round-trip (chosen).** Start the union from `getAll()` ∪ `getModelsOfType("image", prov)` ∪ `getModelsOfType("classifier", prov)` (the latter two feature-detected — absent on 0.87.1/0.83 hosts, which keep the chat-only union), round-trip **every** model with its `type` intact (conditional spreads for `type`/`output`/`inputLimits`/`promptCache`/`samplingParams`), add scan-new chat models. Pros: minimal diff on a proven pattern (`b75b14f`); byte-preserves non-chat models; field-conditional spreads keep 0.87.1 hosts unchanged (their models simply lack those fields). Cons: the allow-list must be maintained — new `Model` fields require a new conditional spread (pinned by tests + runbook).
2. **Register scan-discovered models under a router-owned provider id** (e.g. `openrouter-router`). Rejected: credentials are bound to the existing provider id (`auth.json`, `getApiKeyAndHeaders` resolves per provider); a new id needs separate credential setup, breaks `/model` display continuity, cost tracking, and exclude semantics. Architectural churn to avoid a field allow-list.
3. **`unregisterProvider` + fresh re-registration** (let pi recompose the base, then re-overlay). Rejected: equivalent end state to option 1, but with a visibility gap between the two calls (concurrent `model_select`/streams can observe a providerless window), and it drops the extension's own overlay fields mid-flight.
4. **Do nothing / suppress scans until 0.87.1 rollback.** Rejected: unbounded freeze on the router's core feature; the wipe risk is real and reachable via scan-cache expiry.

## Decision

Option 1: the scan-union site round-trips **all** pi-known models of the provider — chat, image, and classifier — with `type` and the non-chat fields preserved via conditional spreads, and keeps the existing skip check and `find()` fallback. The Ü1 guards at the other registration sites (`registerFreeModelOnDemand`, ollama, group providers) stay unchanged: under 0.99.1 `getRegisteredProviderIds()` includes all builtins, so those paths degrade to "never overwrite a known provider" — conservative and correct.

Implemented by `docs/plans/2026-09-30-router-0.99.1-hardening.md` (Runbook Task 0).

## Consequences

- `/router scan` becomes safe under 0.99.1: openrouter's image and jev-classifier models survive every union re-registration (the round-trip emits exactly the allow-listed fields each model carries — no explicit-`undefined` keys), and non-chat models can no longer leak into the chat list.
- The same code runs unchanged on 0.87.1: the new spreads are conditional on field presence, the `getModelsOfType` calls are feature-detected (skipped where absent), and 0.87.1's `getAll()` does not return non-chat models.
- Compile-vs-runtime skew: the repo's devDependencies pin `@earendil-works/pi-ai ^0.83.0`, so `tsc`/`vitest` cannot type-check 0.99.1-only fields (`type`, `output`, `inputLimits`, `promptCache`, `samplingParams`, `getModelsOfType`). The 0.99.1 contract is therefore pinned by the typed-free mock in the regression test and by tarball verification, not by the compiler — revisit the allow-list and mock whenever the devDependency floor is bumped.
- Recovery story improves: any future bad overlay can be undone in-session with `unregisterProvider` (recomposes builtin + models.json) — documented here so future sessions know the lever exists.
- Maintenance duty: when Pi adds `Model` fields that matter, the round-trip allow-list needs a matching conditional spread. The regression test pins the currently known set.
- Requires a `dist/` rebuild and pi restart before the next scan; the scan cache must not be allowed to expire into an unhardened re-registration (30-day window from its `lastScanTimestamp` (2026-09-29 09:09 CEST) — deadline ≈ **2026-10-29**; the mitigation is the planned owner restart + explicit scan with the hardened build, which makes any later auto-scan harmless. If the restart slips past the deadline, refresh `lastScanTimestamp` in the state-dir scan cache (state dir = `PI_ROUTER_STATE_DIR || extDir`, i.e. `<repo>/dist/.cache/scan-cache.json` for the bundled build) to push the window out).
