/**
 * Virtual group registration, extracted from index.ts (refactor plan
 * 2026-10-02, task 8): registerGroupProviders (virtual providers per model
 * group, Ü1 own-set guard via registeredGroupProviderNames) and
 * registerGroupModels (Ollama merge-not-replace registration, ADR-0021: the
 * router never registers models Pi does not know). buildOrchestratorContext
 * deliberately stays in index.ts. Pure code motion.
 */

import { routerLog } from './logger.ts';
import { setPiRegisteredProviders, setModelRegistry } from './metrics.ts';
import { buildOllamaProviderModels } from './ollama-context.ts';
import { PI_BUILTIN_PROVIDER_IDS } from './providers.ts';
import type { Cache, Config, Metrics } from './types.ts';
import type { Model, Context, SimpleStreamOptions, AssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Dependencies createGroupRegistration reads from index.ts's extension closure. Exposed as
 * live accessors (getters, plus setters for state the moved code writes), so
 * every read sees the CURRENT closure value — index.ts reassigns cfg/router/
 * managers on reload, and a captured copy would go stale.
 */
export interface GroupRegistrationDeps {
  readonly cache: Cache;
  readonly cfg: Config;
  readonly getM: (ref: string) => Metrics;
  readonly groupStream: (model: Model<any>, context: Context, options?: SimpleStreamOptions | undefined) => AssistantMessageEventStream;
  readonly pi: ExtensionAPI;
  readonly resolve: (name: string) => { selected: string; candidates: string[]; } | null;
  readonly sessionCtx: any;
}

export function createGroupRegistration(rt: GroupRegistrationDeps) {
  /**
   * Group provider names the router itself registered. Own-set tracking so
   * the session_start re-register can distinguish "id we own → re-register"
   * from "id someone else owns → refuse" (Ü1): by session_start,
   * getRegisteredProviderIds() contains every group WE registered at load
   * time, and a naive registry guard would skip re-registering all of them.
   */
  const registeredGroupProviderNames = new Set<string>();

  /**
   * Register virtual providers for each model group (strategic, tactical, etc).
   * Called synchronously during extension load so groups are available for
   * --model resolution before session_start fires, and again at
   * session_start (with a registry available) to refresh resolution labels.
   */
  function registerGroupProviders() {
    for (const [groupName, groupCfg] of Object.entries(rt.cfg.model_groups)) {
      // `method: 'dynamic'` groups never resolve here — resolve() always
      // returns null for them by design (see routing.ts Router.resolve):
      // the actual model is picked per-prompt by the classifier hook inside
      // groupStream, not statically at registration time. Calling resolve()
      // anyway would just display a misleading "→ none" in Pi's model
      // picker, so skip it and use a label that reflects what the group
      // actually does.
      const isDynamicGroup = groupCfg.method === 'dynamic';

      // Ü1 guard (AGENTS.md §6; final v1.6.0 review finding I3). The old
      // comment claimed "safe by construction (ADR-0019)" — that only held
      // for the shipped group names. pi.registerProvider REPLACES the
      // provider's `models` array wholesale, so a user-defined group named
      // e.g. "openai" would wipe pi's entire openai catalog for the session.
      // Two-layer guard:
      // 1. Static denylist of pi's builtin provider ids — the only option
      //    at extension load, where pi's extension API exposes no registry
      //    query (a foreign extension registered before us is undetectable
      //    here; documented limitation).
      // 2. At the session_start re-register (when a modelRegistry is
      //    available), refuse ids that are registered but NOT ours.
      if (PI_BUILTIN_PROVIDER_IDS.has(groupName)) {
        routerLog(
          `[groups] Refusing to register model group "${groupName}" as a provider: it would ` +
            `replace pi's builtin provider of the same name (Ü1). Rename the group in router-config.json.`
        );
        continue;
      }
      if (
        (rt.sessionCtx?.modelRegistry as any)?.getRegisteredProviderIds &&
        !registeredGroupProviderNames.has(groupName) &&
        ((rt.sessionCtx?.modelRegistry as any)?.getRegisteredProviderIds?.() as string[]).includes(groupName)
      ) {
        routerLog(
          `[groups] Refusing to register model group "${groupName}" as a provider: ` +
            `another extension already registered that provider id (Ü1). Rename the group.`
        );
        continue;
      }

      const res = isDynamicGroup ? null : rt.resolve(groupName);
      const resolvedRef = res?.selected ?? 'none';
      const resolvedMetrics = res ? rt.getM(resolvedRef) : null;
      const label = isDynamicGroup ? `${groupName} → auto-classify` : `${groupName} → ${resolvedRef}`;

      (rt.pi as any).registerProvider(groupName, {
        baseUrl: 'https://router.local', // not used — streamSimple overrides
        apiKey: 'router-virtual', // not used — streamSimple overrides
        api: `router-group-${groupName}`, // unique per group to avoid overwriting global API providers
        streamSimple: rt.groupStream,
        models: [
          {
            id: groupName,
            name: label,
            reasoning: true,
            input: ['text', 'image'] as any,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: resolvedMetrics ? 200_000 : 128_000,
            maxTokens: 64_000,
          },
          ...(isDynamicGroup ? [{
            id: `${groupName}:use-static`,
            name: `${groupName} → auto-classify (static fallback allowed)`,
            reasoning: true,
            input: ['text', 'image'] as any,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: resolvedMetrics ? 200_000 : 128_000,
            maxTokens: 64_000,
          }] : []),
        ],
      });
      registeredGroupProviderNames.add(groupName);
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────

  async function registerGroupModels(ctx: any) {
    // ADR-0021 (2026-10-02): the router NEVER registers models — or
    // providers — Pi does not already know. This block used to be the
    // scan-union: it resolved keys, round-tripped Pi's own registered models
    // (Ü1 / ADR-0019 field allow-list), and registered the scan-discovered
    // rest under PROVIDER_MAP's api (openai-completions for mistral). That
    // added 29 Mistral models Pi's catalog does not ship — including OCR and
    // audio models registered as chat models — and was the root cause of the
    // Mistral 422 "store" rejections. Pi's registry is the single source of
    // truth for the cloud inventory; the scan now only enriches data
    // (gdpval, pricing, local capabilities) for refs Pi can resolve.
    // Everything that made re-registration "safe" (Ü1 round-trip, roborev
    // 425/426/649 wipes, ADR-0019 non-chat preservation) retired with it.

    // Ollama registration. Ollama defaults to num_ctx=32768 when the request
    // omits options.num_ctx; many models support far more (qwen3.5→262K,
    // gemma4→131K), so prompts >32K truncate unless num_ctx is sent.
    //
    // Per Guardrail 3 + Ü1, this must NOT overwrite an existing Ollama
    // registration: pi-known Ollama models are authoritative and WIN the
    // merge below (their typed fields are round-tripped untouched). num_ctx
    // comes from the REAL capabilities the scan captured live from Ollama's
    // /api/show (see src/ollama-context.ts + src/capabilities.ts) — no
    // hardcoded table, no dependency on any specific Ollama extension.
    //
    // METADATA ONLY (roborev 719, verified against pi-ai 1.0.0 dist): pi-ai
    // never reads a model-level `providerOptions` field at request time —
    // only `samplingParams` reaches the request body. So providerOptions.
    // num_ctx on registered models is FORWARD-COMPAT METADATA (correct
    // values from /api/show for the day pi-ai forwards them), not a runtime
    // knob. What IS load-bearing at runtime is the `contextWindow` field:
    // Pi uses it for compaction, overflow avoidance ('context window
    // 32768 < 35514 tokens needed') and candidate filtering. Ollama's own
    // server-side truncation is governed by OLLAMA_CONTEXT_LENGTH /
    // Modelfile PARAMETER num_ctx — outside the router's reach (owner
    // decision if that ever needs raising).
    //
    // KNOWN LIMITATIONS (roborev 719):
    //   - the registration pins apiKey 'ollama' + http://localhost:11434/v1;
    //     a models.json ollama provider with a DIFFERENT baseUrl/apiKey
    //     would be overridden on the merge path. Accepted: the scan only
    //     ever inventories localhost:11434, so remote/proxy Ollama setups
    //     were never routable through this block anyway.
    //   - once registered, a scan-only model stays registered for the
    //     process lifetime even if it is deleted from Ollama (the next
    //     scan drops it from the cache, but getAll() keeps reporting the
    //     old entry until pi restarts).
    //   - after a merge the extension overlay owns the ollama model list,
    //     so hand-edits to models.json ollama models are masked until the
    //     next pi restart (the overlay wins over the re-read models.json).
    //   - ordering (pre-existing, not introduced here): registerGroupModels
    //     runs at session_start BEFORE the background scan fills the cache,
    //     so on a brand-new machine (no scan cache yet) the FIRST session
    //     registers nothing and Ollama models appear from the second
    //     session onward.
    //
    // GUARD FIX (2026-10-02, owner decision on the defect found during the
    // ADR-0021 investigation): the old guard compared TAGGED scan ids
    // (`gemma4:latest`) against UNTAGGED models.json ids (`gemma4`) with
    // exact find() — it never matched, so the router re-registered Ollama
    // on EVERY session_start (83× in the live log), and because
    // applyExtension drops models.json entries whenever the extension
    // overlay defines `models` (ADR-0019), that re-registration WIPED the
    // user's models.json registration every session.
    //
    // The fix is a MERGE, not a skip and not a replace:
    //   - pi-known Ollama models are round-tripped with their typed fields
    //     and WIN the normalized-id dedup (`gemma4` ≡ `gemma4:latest`;
    //     tagged variants like `gemma4:12b-mlx` stay distinct and are added),
    //   - scan-only models are ADDED with real contextWindow (Pi-side
    //     compaction/overflow correctness) and providerOptions.num_ctx
    //     metadata — this registration is the ONLY source of the user's
    //     classifier models (e.g. `ollama/mistral-nemo:latest`), which live
    //     in neither Pi's catalog nor models.json. Known models are
    //     round-tripped AS-IS (a user-set providerOptions is never
    //     overwritten — roborev 719 found model-level providerOptions
    //     inert in pi-ai 1.0.0, so an enrichment branch would be dead
    //     weight; dropped rather than kept inconsistent),
    //   - if the registry already knows every scanned model, NOTHING is
    //     registered (idempotent — models.json stays the sole overlay).
    try {
      const ollamaModels = (rt.cache.available_models ?? [])
        .filter((m) => m.provider === 'ollama');
      if (ollamaModels.length > 0) {
        // Pi's current Ollama models: models.json and/or a prior
        // registration. getAll() is chat-only (ADR-0019) — fine here:
        // local Ollama models are chat models and Pi ships no builtin
        // ollama catalog with non-chat inventory. find() fallback (over
        // the scanned ids) keeps hosts without getAll() working.
        let piKnownModels: any[] = [];
        try {
          piKnownModels = ((ctx.modelRegistry as any).getAll?.() ?? []).filter(
            (m: any) => m.provider === 'ollama'
          );
        } catch {
          piKnownModels = [];
        }
        if (!piKnownModels.length) {
          // Fallback for hosts without getAll(): try both tagged and
          // untagged variants (the guard-bug fix is normalization-aware,
          // so the fallback must be too — otherwise it regresses to the
          // pre-fix wipe behavior when getAll() is absent).
          for (const m of ollamaModels) {
            const tagged = m.id;
            const untagged = tagged.endsWith(':latest')
              ? tagged.slice(0, -':latest'.length)
              : tagged;
            const found =
              ctx.modelRegistry.find('ollama', tagged) ??
              ctx.modelRegistry.find('ollama', untagged);
            if (found) piKnownModels.push(found);
          }
        }
        // Normalized-id dedup: Ollama resolves an untagged name to
        // `:latest`, so `gemma4` (models.json) and `gemma4:latest` (scan)
        // name the SAME model — the registry version wins (its typed fields
        // are the user's intent). Other tags are genuinely different models.
        const normId = (id: string): string =>
          id.endsWith(':latest') ? id.slice(0, -':latest'.length) : id;
        const knownByNorm = new Map<string, any>();
        for (const m of piKnownModels) knownByNorm.set(normId(m.id), m);
        const newScanModels = ollamaModels.filter((m) => !knownByNorm.has(normId(m.id)));

        if (!piKnownModels.length) {
          // Pi does not know Ollama at all: register the scan inventory
          // with real num_ctx (the original pre-guard-fix behavior).
          const providerModels = buildOllamaProviderModels(ollamaModels);
          (rt.pi as any).registerProvider('ollama', {
            name: 'Ollama (local)',
            baseUrl: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            api: 'openai-completions',
            models: providerModels,
          });
          routerLog(`[router] Registered Ollama with real contextWindow (+ num_ctx metadata) for ${providerModels.length} model(s) (Pi did not know Ollama)`);
        } else if (newScanModels.length > 0) {
          // MERGE: round-trip pi-known models AS-IS (ADR-0019 field
          // allow-list — applyExtension would otherwise drop the
          // models.json entries; a user-set providerOptions is preserved,
          // never enriched/overwritten), then add the scan-only models.
          const existingModels = piKnownModels.map((m: any) => ({
            id: m.id,
            name: m.name,
            ...(m.api !== undefined ? { api: m.api } : {}),
            ...(m.baseUrl !== undefined ? { baseUrl: m.baseUrl } : {}),
            ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
            ...(m.thinkingLevelMap !== undefined ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
            ...(m.input !== undefined ? { input: m.input } : {}),
            ...(m.cost !== undefined ? { cost: m.cost } : {}),
            ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
            ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
            ...(m.headers !== undefined ? { headers: m.headers } : {}),
            ...(m.compat !== undefined ? { compat: m.compat } : {}),
            ...(m.type !== undefined ? { type: m.type } : {}),
            ...(m.output !== undefined ? { output: m.output } : {}),
            ...(m.inputLimits !== undefined ? { inputLimits: m.inputLimits } : {}),
            ...(m.promptCache !== undefined ? { promptCache: m.promptCache } : {}),
            ...(m.samplingParams !== undefined ? { samplingParams: m.samplingParams } : {}),
            ...(m.providerOptions !== undefined ? { providerOptions: m.providerOptions } : {}),
          }));
          const providerModels = [
            ...existingModels,
            ...buildOllamaProviderModels(newScanModels),
          ];
          (rt.pi as any).registerProvider('ollama', {
            name: 'Ollama (local)',
            baseUrl: 'http://localhost:11434/v1',
            apiKey: 'ollama',
            api: 'openai-completions',
            models: providerModels,
          });
          routerLog(`[router] Merged Ollama registration: kept ${existingModels.length} pi-known model(s), added ${newScanModels.length} scan-only model(s)`);
        }
        // else: the registry already knows every scanned model — register
        // NOTHING (pre-fix this re-registered and wiped models.json).
      }
    } catch (e) {
      routerLog('[router] Ollama registration failed:', e);
    }

    // F11 (2026-09-02): refresh the metrics module's view of pi's registered
    // providers after registration. registerGroupModels may have registered
    // the LOCAL Ollama provider, and registerGroupProviders the router's
    // virtual group providers — stripProvider needs to recognize them too.
    // (ADR-0021: no cloud provider is registered here anymore.)
    try {
      const ids = (ctx.modelRegistry as any).getRegisteredProviderIds?.() ?? [];
      setPiRegisteredProviders(ids);
      // Refresh the registry handle too — the registrations above may have
      // added providers whose `Model.cost` we now want to read.
      setModelRegistry((ctx as any).modelRegistry);
    } catch {
      /* registry may not expose getRegisteredProviderIds — leave the existing set */
    }

    // Re-register group providers with updated resolution info
    registerGroupProviders();
  }

  return { registerGroupProviders, registerGroupModels };
}
