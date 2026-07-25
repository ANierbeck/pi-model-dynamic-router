# Plan: Route pi-registered models from providers not in `PROVIDER_MAP`

## Problem

Models that pi has already registered but whose provider is **not** defined in
`src/providers.ts` `PROVIDER_MAP` (e.g. `claude-bridge/claude-sonnet-5`,
`claude-bridge/claude-opus-4-8`) are **visible but unroutable**.

### Root cause (verified)

1. `allDiscoveredRefs()` (`src/routing.ts:63`) already includes them — it reads
   `sessionCtx.modelRegistry.getAvailable()`, so `claude-bridge/...` refs are in the
   discovered universe during a session.
2. But every routing path filters to an explicit per-group allowlist:
   `allDiscoveredRefs().filter(ref => g.models?.includes(ref))`
   (`routing.ts:199`, `:279`, and the fallback `:427`).
3. Those `g.models` lists are built by `generateDynamicConfig()` (`index.ts:505`)
   from `allModelRefs = staticFreeModels ∪ cache.available_models`.
4. `cache.available_models` is populated **only** by `scan()`, which iterates
   `Object.entries(PROVIDER_MAP)`. Unknown providers never get scanned → never
   scored → never assigned to a group → filtered out at routing.

```
PROVIDER_MAP ──scan──▶ cache.available_models ──generate──▶ g.models ──filter──▶ routable
```

So the gate is **group membership**, and group membership is a closed world keyed
off `PROVIDER_MAP`. This is a systematic blind spot for ANY already-registered
provider the router doesn't define — claude-bridge is just the first one noticed.

## Goal

Any model in pi's registry (`modelRegistry.getAvailable()`) should become a routing
candidate — provided a metric (GDPval) can be inferred for it — WITHOUT requiring a
`PROVIDER_MAP` entry. `PROVIDER_MAP` remains the source for scan + key discovery of
providers the router manages itself.

## Design

Union registry-sourced refs into `generateDynamicConfig`'s candidate pool, then let
the existing `.filter(m => m.gdpval > 0)` (`index.ts:548`) act as the safety gate:
models whose base name resolves to a known GDPval score get in; genuinely unknown
models with no score are dropped (safe default).

Metric inference is *almost* free because `lookupGdp` (`src/metrics.ts:109`) already
does base-token fuzzy matching (`claude-sonnet-5` → known score). The ONE blocker is
provider stripping.

### CRITICAL sub-issue: `stripProvider` won't strip unknown providers

`stripProvider` (`src/metrics.ts:71`) strips the prefix only if
`PROVIDER_MAP[prov] || cfg.providers[prov]`. For `claude-bridge` neither exists, so
`mapLookup`/`lookupGdp` see `claude-bridge/claude-sonnet-5`, `baseTokens` includes
`"bridge"`, and the token-set match against `claude-sonnet-5` FAILS.

**Fix:** register a lightweight stub for each unknown registry provider in
`cfg.providers` before metric lookup, e.g.
`cfg.providers['claude-bridge'] ??= { billing: 'subscription' }`.
Because `stripProvider` checks `cfg.providers?.[prov]`, this immediately makes
stripping (and therefore GDPval/price inference and cost-tier logic) work.
NOTE: keep provider-id-with-slash safety — model ids from e.g. openrouter contain a
slash; only strip the FIRST segment (which is what `stripProvider` already does).

## Implementation steps (for the delegate)

### Step 1 — Collect registry refs in `generateDynamicConfig`
File: `index.ts`, function `generateDynamicConfig` (~`index.ts:505`).

- After building `staticFreeModels` and before `allModelRefs`, gather registry refs:
  ```ts
  const registryRefs: string[] = [];
  const reg = sessionCtx?.modelRegistry;
  if (reg) {
    for (const m of reg.getAvailable()) registryRefs.push(`${m.provider}/${m.id}`);
  }
  ```
- Union into the pool:
  ```ts
  const allModelRefs = [...new Set([
    ...staticFreeModels,
    ...scannedModels.map(m => `${m.provider}/${m.id}`),
    ...registryRefs,
  ])];
  ```

### Step 2 — Stub-register unknown providers so metric inference works
Still in `generateDynamicConfig`, before the `allModelRefs.map(ref => …)` metric
enrichment block (`index.ts:538`):

```ts
for (const ref of registryRefs) {
  const prov = ref.slice(0, ref.indexOf('/'));
  if (prov && !PROVIDER_MAP[prov] && !cfg.providers?.[prov]) {
    (cfg.providers ??= {})[prov] = { billing: 'subscription' };
  }
}
```
- Verify import of `PROVIDER_MAP` exists in `index.ts` (it does: `index.ts:33`).
- `cfg` is the live config used by `stripProvider` via `(global as any).cfg`
  (`metrics.ts:75`). Confirm `cfg` is assigned to `global.cfg` somewhere; if not,
  ensure the stub goes onto the same object `stripProvider` reads. Grep for
  `global.cfg` / `(global as any).cfg =` and wire accordingly.

### Step 3 — Ensure generation actually runs when registry is populated
- `scan()` (`index.ts:362`) is called from `onSessionStart` (`index.ts:943`) AFTER
  `sessionCtx` is set (`index.ts:931`), so the registry IS available then. Good.
- BUT `generateDynamicConfig` early-returns if `isScanCacheValid()` and not `force`
  (`index.ts:517`). Registry contents can differ from the cached scan. Add a
  condition: regenerate if any `registryRefs` entry is absent from all existing
  `g.models`. Simplest: compute a small "registry signature" and force regen when it
  changes, or just always union registry refs at generation time (cheap) and drop the
  cache-valid short-circuit's ability to skip when new registry models are present.
- Keep the existing GDPval-scan cache validity for the expensive web scan; only the
  group-membership generation needs to see registry deltas.

### Step 4 — Confirm routing picks them up
No routing change needed: once `claude-bridge/claude-sonnet-5` is in a group's
`g.models`, `resolve()`/`resolveWithCostTier()` filters (`routing.ts:199`,`:279`)
will include it, and sorting uses `lookupGdp`/`calculateScore` which now resolve via
the stubbed provider.

## Verification

1. `npm run build` (tsc) clean.
2. Unit: add a test (near `routing.test.ts` / `model-utils.test.ts`) that seeds a
   fake `modelRegistry.getAvailable()` returning `claude-bridge/claude-sonnet-5`,
   runs `generateDynamicConfig`, and asserts the ref lands in the appropriate
   group's `models` and that `resolve('strategic'|'tactical')` can select it.
3. Assert base-name inference: `lookupGdp('claude-bridge/claude-sonnet-5')` returns a
   non-null score AFTER the provider stub is added (and null before — regression
   guard for the stripProvider fix).
4. Assert safety: a registry ref with no derivable GDPval (e.g.
   `claude-bridge/totally-unknown-xyz`) is dropped by `.filter(m => m.gdpval > 0)`
   and does NOT appear in any group.
5. Manual in PI: `/router` should list claude-bridge models under a group; routing a
   group should be able to select one.

## Out of scope / guardrails
- Do NOT add `claude-bridge` to `PROVIDER_MAP` — the whole point is to generalize.
- Do NOT let unknown models default to a fabricated GDPval; require a real inferred
  score so junk providers don't pollute groups.
- Preserve `stripProvider`'s first-segment-only behavior (openrouter ids contain `/`).
- Follow release rules: batch with other pending fixes, review + local PI test before
  tagging (see memory: release-process, pending-fixes).

## Key file:line references
- `src/routing.ts:63` `allDiscoveredRefs()` (already reads registry)
- `src/routing.ts:199,279,427` group-membership filters (the gate)
- `index.ts:505` `generateDynamicConfig` (primary change site)
- `index.ts:514` `scannedModels = cache.available_models`
- `index.ts:538-548` metric enrichment + `.filter(m => m.gdpval > 0)` safety gate
- `index.ts:517` scan-cache-valid early return (Step 3)
- `index.ts:33` `PROVIDER_MAP` import
- `src/metrics.ts:71` `stripProvider` (must recognize provider — Step 2)
- `src/metrics.ts:109` `lookupGdp` (base-token inference — works once stripped)
