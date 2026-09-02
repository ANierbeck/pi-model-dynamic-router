# 0005 — `registerProvider` replaces (not merges) — Ü1 guard design

## Status

Accepted (2026-09-02).

## Context

`pi.registerProvider(name, { models })` has a non-obvious semantics trap:
when `models` is provided, it **replaces** the provider's entire model
list — it does NOT merge with any existing registration. This is
documented in pi's own
`node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`:
*"When models is provided, it replaces all existing models for that
provider"*, and is restated in this repo's `AGENTS.md` rule #6 as a hard
rule for any agent working in this repo.

The router's `registerGroupModels` (in `index.ts`) has an "Ü1 guard" whose
stated purpose is to protect pi's existing registrations from being
overwritten — especially `models.json` entries carrying user-curated
compat flags (e.g. `mistral-zai/zai-glm-5-2` with `compat: { supportsStore:
false }`) and extension-provided providers. The guard historically worked
by skipping a whole provider if pi already knew ANY one of its models.

Finding F4 (2026-09-02 architecture review) made the Ü1 guard check models
individually — if pi knows SOME but not all of a provider's models, skip
the known ones and register the rest — so that scored scan-discovered
variants (e.g. `mistral-zai/glm-5-2`, gdpval 1497) become visible to
routing without overwriting the unscored `zai-glm-5-2` pi already knows.

The first version of that fix called
`pi.registerProvider(provId, { models: newModels })` with ONLY the
newly-discovered models. **Roborev job 426 (HIGH) correctly flagged this
as a destructive overwrite**: in the mixed case (pi knows some but not
all models), passing only `newModels` would silently DELETE pi's
existing registration for the models it already knew, compat flags
included — exactly the destructive overwrite Ü1 exists to prevent,
reintroduced for the very provider (`mistral-zai`) the fix was written
to unblock.

## Decision Drivers

- **`registerProvider`'s replace-semantics are non-negotiable.** Pi's
  documented behavior is replace, not merge; the router cannot change
  that. Any `registerProvider` call with a `models` field must therefore
  include the FULL intended model list, not just the delta.
- **Ü1's purpose is to protect existing registrations.** Any fix that
  deletes the entries it's supposed to protect is worse than the bug it
  fixes — it turns a "model invisible" problem into a "model + its compat
  flags deleted" problem.
- **Per-provider error isolation.** `registerGroupModels` iterates
  `PROVIDER_MAP`; a throw for one provider must not abort registration
  for the rest (roborev jobs 429 + 432: the `find()` loop and
  `existingModels` construction must live inside the per-provider try/catch).
- **AGENTS.md rule #6.** "Never register a provider with a partial model
  list when it might already be registered with more models — check
  `getRegisteredProviderIds` first (the Ü1 invariant)." This applies to
  the mixed case too: the partial list is only safe if it's the UNION.

## Options Considered

### A — Pass only `newModels` to `registerProvider` (rejected)

The first version of the F4 fix. Skip the known models, register only
the new ones.

- **Pros:** Smallest diff; directly expresses "register the new ones."
- **Cons — this is why it's rejected:** Deletes pi's existing entries for
  the known models (replace-semantics). Roborev job 426 HIGH. This is the
  exact failure mode Ü1 exists to prevent.

### B — Round-trip pi's known models + pass the UNION (accepted)

Build `existingModels` by calling `ctx.modelRegistry.find(provId, m.id)`
for each known model, round-tripping only the documented
`ProviderModelConfig` fields (id, name, api, baseUrl, reasoning,
thinkingLevelMap, input, cost, contextWindow, maxTokens, headers, compat)
— pi's `Model` interface also carries a `provider` field that
`ProviderModelConfig` doesn't declare, so pick the known-safe fields
instead of spreading the whole object. Pass
`models: [...existingModels, ...newModels.map(...)]` so the
`registerProvider` call is a true add, not a replace.

- **Pros:** Preserves pi's existing entries byte-for-byte (compat flags
  included), registers the new ones, and respects replace-semantics. The
  round-trip only copies documented fields, so it won't leak internal
  `Model` properties pi doesn't expect on re-registration.
- **Cons:** More code than Option A; calls `find()` twice per known model
  unless cached. Mitigation (roborev job 429 LOW): cache `find()` results
  in a `Map<string, Model>` built once and reused for both the
  set-membership check and the round-trip lookup.

### C — Skip the whole provider if pi knows ANY model (the old behavior, rejected)

The pre-F4 Ü1 guard. If pi knows even one model, skip the provider
entirely.

- **Pros:** Zero risk of overwrite — never calls `registerProvider` at
  all for that provider.
- **Cons — why this is the bug F4 fixed:** Leaves scored scan-discovered
  variants (e.g. `mistral-zai/glm-5-2`, gdpval 1497) unregistered and
  invisible to routing, so the group's `min_gdpval` gate filters them out
  and the cascade falls through to a weaker model. This is the "router
  still goes for minimax-m2.7:free" symptom.

## Decision

**Option B.** The Ü1 guard checks models individually. In the mixed case,
`existingModels` is built by round-tripping pi's own already-known
`Model` objects (preserving compat flags), and `registerProvider` is
called with the UNION of `existingModels` and `newModels`. The whole
per-provider body (the `find()` loop, `existingModels` construction,
`newModels` filter, and `registerProvider` call) is wrapped in one
try/catch so a throw for any single provider only `continue`s to the
next provider. `find()` results are cached in a `Map` to avoid redundant
lookups (roborev job 429 LOW).

## Consequences

- Scored scan-discovered variants (e.g. `mistral-zai/glm-5-2`) are now
  registered alongside the unscored variants pi already knows, without
  deleting pi's compat flags.
- Real `cost_per_m` from the scan is used instead of hardcoded 0 (a real
  improvement for providers whose scan fetches verified pricing; a
  no-op for generic direct-API providers whose `cost_per_m` is 0 by
  placeholder).
- Regression test: `test/register-group-models-merge-not-replace.test.ts`
  (verified to fail against the pre-fix code `[ 'glm-5-2' ] does not
  include 'zai-glm-5-2'` and pass against the fix).
- Any future change to `registerGroupModels` must respect this pattern:
  never pass a partial model list to `registerProvider` for a provider
  pi already knows — always the UNION, or skip entirely.
