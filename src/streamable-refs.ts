// src/streamable-refs.ts
// Streamability filter for the persist path (dynamic config generation).
//
// Extracted from index.ts's generateDynamicConfig so the rule can be unit
// tested without instantiating the full Pi extension.
//
// Background (2026-09-20 ghost-model incident): generateDynamicConfig built
// its model pool from static free_models ∪ scan-cache refs ∪ registry refs,
// so stale scan-cache entries flowed straight into the generated group
// configs even though Pi's registry could never serve them. Combined with
// scan-placeholder costs of $0 and the pool's best GDPval, such ghost refs
// won every cost-sorted group and then failed (or worse: silently burned
// real money via a registered alias provider) at stream time.
//
// The rule: a ref may only enter the generated config if it can actually be
// streamed. The live paths already intersect candidates with registry refs
// (allDiscoveredRefs), and registerGroupModels registers scan-discovered
// models at session start, so "resolvable in Pi's registry" is the
// authoritative streamability signal. Local runtimes (ollama) and refs the
// user explicitly listed as free models are exempt.

export interface StreamableRefContext {
  /** Registry resolution, e.g. metrics' findRegistryModel wrapper. */
  hasRegistryModel(provider: string, modelId: string): boolean;
  /** True for local runtimes (ollama) whose models may not be registered. */
  isLocalProvider(provider: string): boolean;
  /** Refs explicitly listed in cfg.providers[*].free_models. */
  freeModelRefs: ReadonlySet<string>;
}

/**
 * Whether a "provider/modelId" ref can plausibly be streamed right now:
 * registered in Pi's registry, served by a local runtime, or explicitly
 * configured as a free model (stream-time on-demand registration covers
 * those). Malformed refs (no provider prefix) are not streamable.
 */
export function isStreamableRef(ref: string, ctx: StreamableRefContext): boolean {
  const slash = ref.indexOf('/');
  if (slash <= 0) return false;
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  if (!modelId) return false;
  if (ctx.freeModelRefs.has(ref)) return true;
  if (ctx.isLocalProvider(provider)) return true;
  return ctx.hasRegistryModel(provider, modelId);
}
