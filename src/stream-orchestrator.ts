/**
 * src/stream-orchestrator.ts — Streaming orchestration
 *
 * Extracted from index.ts (3656-line defaultExport closure) to break up the
 * god-object. groupStream (~430 lines) and driveStream (~950 lines) together
 * account for ~38% of index.ts and are the most complex functions in the
 * codebase — both are now methods of this class.
 *
 * Both functions close over a StreamOrchestratorContext (passed at construction
 * and updated on reload). Context fields that are reassigned mid-session (cfg,
 * cache) are passed as mutable object references, not copied, so the
 * orchestrator always reads the current value without needing a reload signal.
 *
 * helpers that are used by both streaming AND non-streaming code paths
 * (resolve, tryStream, isLimited, estimateContextTokens, etc.) remain in
 * index.ts and are passed as bound-call fields on the context.
 */
import type {
  Model,
  Context,
  SimpleStreamOptions,
  AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type { SourceModelInfo } from './stream-driver.ts';
import type { Config, Cache } from './types.ts';
import { Router } from './routing.ts';
import type { SessionEscalation } from './escalation.ts';
import type { RateLimitManager } from './rate-limit.ts';
import type { CacheManager } from './cache.ts';
/** Bounded sleep helper — used by the wait-for-reset paths. */
const sleepMs = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Per-candidate cancellation. Each stream attempt gets its own AbortSignal,
 * chained to the caller's (Ctrl-C still reaches the provider), so the router
 * can cancel exactly the candidate it gives up on.
 *
 * Without it an abandoned candidate was never told to stop: claude-bridge
 * only cancels its Claude Agent SDK query on options.signal abort, so every
 * discarded attempt ran to completion in the background — burning
 * subscription tokens for an answer nobody read and piling concurrent
 * queries onto the bridge's shared session (2026-09-27 afternoon: Claude
 * usage ~50% within one short debugging session).
 *
 * `abandon()` must only be called for a FAILED attempt. A successful
 * toolUse turn keeps the bridge's SDK query alive for the tool results;
 * aborting the winner would kill the tool loop.
 */
function openCandidateAttempt(options: SimpleStreamOptions | undefined): {
  options: SimpleStreamOptions;
  abandon: () => void;
} {
  const controller = new AbortController();
  const outer = options?.signal;
  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  return {
    options: { ...(options ?? {}), signal: controller.signal },
    abandon: () => {
      // Drop the chain listener so a long cascade doesn't accumulate one
      // listener per failed candidate on the caller's signal.
      outer?.removeEventListener('abort', onOuterAbort);
      if (!controller.signal.aborted) controller.abort(new Error('router abandoned this candidate'));
    },
  };
}

/**
 * Extracts the actual context window and requested tokens from an OpenRouter
 * (or compatible) overflow error detail JSON.
 *
 * Example detail:
 *   'prompt is too long: 400: {"message":"This endpoint's maximum context
 *    length is 196608 tokens. However, you requested about 197318 tokens...",
 *    "code":400}'
 *
 * Returns { actualContextWindow, requestedTokens } or null if the detail is
 * absent or unparseable (e.g. a non-JSON provider error).
 */
function extractContextWindowFromError(detail: string | undefined): {
  actualContextWindow: number;
  requestedTokens: number;
} | null {
  if (!detail) return null;
  // Patterns mirror pi-ai's isContextOverflow() OVERFLOW_PATTERNS for the
  // OpenRouter family ("maximum context length is X tokens"), extended to also
  // capture the requested-token count. No leading quote so this matches both
  // the raw JSON-quoted form and a plain-text provider message.
  const cwMatch = detail.match(/maximum context length is (\d+) tokens/);
  const reqMatch = detail.match(/requested about (\d+) tokens/);
  if (!cwMatch || !reqMatch) return null;
  const cw = parseInt(cwMatch[1], 10);
  const req = parseInt(reqMatch[1], 10);
  if (!cw || !req) return null;
  return { actualContextWindow: cw, requestedTokens: req };
}

import { type ClassificationResult } from './content-classifier.ts';
import type { CostTracker } from './cost-tracker.ts';
import { resolveShortModelName, stripRouterNarration, hintTargetMatches, normalizeHintName } from './utils.ts';
import { rankHintCandidates, isRefUsable } from './hint-resolution.ts';
import { getFallbackGroup } from './routing.ts';
import { PROVIDER_MAP } from './providers.ts';
import { isExcluded } from './exclude.ts';
import { isBlocked } from './model-blocklist.ts';
import { wedgeFixHint, WEDGE_COOLDOWN_TEXT } from './provider-watchdog.ts';
import { appendRawLog, routerLog } from './logger.ts';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import {
  pushStreamError,
  pushRouterInfo,
  pushRouterInfoLogged,
  isExpectedTransientError,
} from './stream-driver.ts';
import {
  isRateLimitText,
  isOverflowErrorText,
  isOverflowDeltaText,
  parseResetAtMs,
  isPaidCloudRateLimitFailure,
} from './detection.ts';

// ── Context interface ───────────────────────────────────────────────────────

export interface StreamOrchestratorContext {
  // Mutable session state
  curModel: string;
  activeGroup: string | null;
  lastDynamicModel: string;
  lastClassifiedCategory: ClassificationResult['category'] | undefined;
  sessionCtx: any;
  // Core objects (updated on config reload)
  cfg: Config;
  cache: Cache;
  router: Router;
  escalation: SessionEscalation;
  /** Retained for interface compatibility; cost tracking moved to turn_end
   * in index.ts (2026-09-27, review I2 — selection-time tracking passed
   * fabricated token counts). */
  costTracker?: CostTracker;
  rateLimitManager: RateLimitManager;
  cacheManager: CacheManager;

  // Helpers used by both streaming and non-streaming code — defined in index.ts
  resolve: (name: string) => { selected: string; candidates: string[] } | null;
  isLimited: (ref: string) => boolean;
  clearLimit: (ref: string) => void;
  tryStream: (
    ref: string,
    context: Context,
    options: SimpleStreamOptions | undefined
  ) => Promise<{ stream: AssistantMessageEventStream; ref: string } | null>;
  estimateContextTokens: (context: Context) => number;
  getModelContextWindow: (ref: string) => number | null;
  /**
   * Updates the model registry with a discovered context window so future
   * requests skip this model for the current context size without needing a
   * fresh error. Mutates the registry entry in-place.
   */
  updateModelContextWindow: (ref: string, cw: number) => void;
  getEmptyResponseTimeout: (ref: string) => number;
  getStallTimeout: (ref: string) => number;
  /** Max ms to wait for a rate-limited model with a known, near reset (0 = off). */
  getRateLimitWaitMaxMs: () => number;
  consumeWithDetection: (
    stream: AssistantMessageEventStream,
    proxy: AssistantMessageEventStream,
    emptyResponseTimeoutMs: number,
    stallTimeoutMs: number,
    ref: string
  ) => Promise<{ ok: boolean; reason?: string; resetAtMs?: number; detail?: string | undefined }>;
  isLocalProvider: (ref: string) => boolean;
  localStreamLimit: () => number;
  releaseLocalSlot: (ref: string) => void;
  recordOk: (ref: string) => void;
  /** Feeds a failure text into the learned blocklist (ADR-0008). */
  observeFailure: (ref: string, failureText: string) => void;
  /** Local-provider watchdog (ADR-0016): true when this timeout newly marks the provider wedged. */
  observeLocalTimeout: (ref: string) => boolean;
  isProviderWedged: (ref: string) => boolean;
  recordStreamFailure: (
    ref: string,
    reason: string,
    resetAtMs?: number,
    errorText?: string
  ) => { hardLimited: boolean; rotated: boolean; newKey: string | undefined };
  formatResetMsg: (ref: string, resetAtMs: number | undefined, rotated: boolean | undefined) => string;
  // Classification helpers
  classifyPrompt: (prompt: string, opts: any) => Promise<any>;
  detectHintDirectly: (prompt: string) => any;
  getGroupForCategory: (category: string) => string;
  // Context helpers
  extractLastUserPrompt: (context: Context) => string | undefined;
  extractLastAssistantSnippet: (context: Context) => string | undefined;
  isCompactionTurn: (context: Context) => boolean;
  lookupGdp: (ref: string) => number | null;
  // Module-level state (written by tryStream; read by driveStream)
  skipReasons: Map<string, string>;
  localStreamsInFlight: number;
}

// ── Orchestrator ───────────────────────────────────────────────────────────

export class StreamOrchestrator {
  constructor(public ctx: StreamOrchestratorContext) {}

  // ── groupStream ─────────────────────────────────────────────────────────

  groupStream(
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream {
    const { cfg, cache, router } = this.ctx;
    const useStaticMatch = model.id.match(/^(.+):use-static$/);
    const useStatic = useStaticMatch !== null;
    const groupName = useStaticMatch ? useStaticMatch[1] : model.id;
    const g = cfg.model_groups[groupName];
    const isDynamic = g?.method === 'dynamic';
    const sourceModel: SourceModelInfo = { provider: model.provider, id: model.id, api: model.api };

    if (!isDynamic) {
      const res = this.ctx.resolve(groupName);
      if (!res) throw new Error(`No available models for group "${groupName}"`);
      const proxy = createAssistantMessageEventStream();
      const candidates = [...res.candidates];
      // Cost tracking moved to turn_end (2026-09-27, review I2): the old
      // selection-time call passed hardcoded 1000/500 tokens — fabricated
      // audit data. Only completed turns with REAL provider-reported usage
      // are tracked now.
      this.driveStream(proxy, candidates, context, options, undefined, groupName, undefined, sourceModel);
      return proxy;
    }

    // Dynamic group
    const proxy = createAssistantMessageEventStream();
    (async () => {
      let candidates: string[];
      let dynamicLabel: string | undefined;
      let resolvedGroup: string | undefined;
      try {
        const prompt = this.ctx.extractLastUserPrompt(context);
        const lastMsg = context.messages[context.messages.length - 1];
        const isToolFollowUp =
          lastMsg?.role === 'toolResult' && !!this.ctx.lastDynamicModel && !this.ctx.detectHintDirectly(prompt ?? '');
        if (isToolFollowUp) {
          let followUpGroup = 'fallback';
          let res = this.ctx.resolve(followUpGroup);
          if (!res) {
            const alt = Object.keys(cfg.model_groups).find(
              (k) => cfg.model_groups[k].method !== 'dynamic'
            )!;
            followUpGroup = alt;
            res = this.ctx.resolve(alt);
          }
          if (!res) throw new Error('No fallback model for tool follow-up');
          candidates = [this.ctx.lastDynamicModel, ...res.candidates.filter((r) => r !== this.ctx.lastDynamicModel)];
          await this.driveStream(proxy, candidates, context, options, undefined, followUpGroup, undefined, sourceModel);
          return;
        }

        const lastAssistantSnippet = this.ctx.extractLastAssistantSnippet(context);
        const previousUserMessage = this.extractPreviousUserMessage(context);
        const dynamicGroupCfg = cfg.model_groups['dynamic'];
        const stripOllama = (ref: string) => ref.replace(/^ollama\//, '');
        const classifyOpts: any = {
          allowStaticFallback: useStatic,
          allowCloudFallback: dynamicGroupCfg?.classifier_cloud_fallback === true,
          cfg,
          cache,
          // Cloud fallback uses pi's own model registry (completeSimple) so pi
          // owns auth + provider HTTP — the user's keys live in pi's auth store,
          // not router-config.json, so the router must NOT roll its own key
          // resolution / HTTP client. findModel resolves a ref to a pi Model;
          // completeSimple runs the one-shot call.
          findModel: (ref: string) => {
            const registry = this.ctx.sessionCtx?.modelRegistry;
            if (!registry) return undefined;
            const i = ref.indexOf('/');
            if (i === -1) return undefined;
            return registry.find(ref.slice(0, i), ref.slice(i + 1));
          },
          completeSimple: (model: any, ctx: any, options: any) => {
            // completeSimple is on the private ModelRuntime (registry.runtime),
            // not the public ModelRegistry facade — same reach-through pattern
            // hostStreamSimple uses for streamSimple (index.ts:1635). The
            // pinned harness (pi-coding-agent@0.83.0) exposes neither method
            // on the facade itself.
            const registry = this.ctx.sessionCtx?.modelRegistry as any;
            return registry?.runtime?.completeSimple?.(model, ctx, options);
          },
          context: {
            lastAssistantSnippet,
            previousUserMessage,
            lastCategory: this.ctx.lastClassifiedCategory,
            lastModel: this.ctx.lastDynamicModel || undefined,
            isCompaction: this.ctx.isCompactionTurn(context),
            lastModelLimited: this.ctx.lastDynamicModel ? this.ctx.isLimited(this.ctx.lastDynamicModel) : false,
          },
        };
        if (dynamicGroupCfg?.classifier_model) classifyOpts.model = stripOllama(dynamicGroupCfg.classifier_model);
        if (dynamicGroupCfg?.classifier_fallback) classifyOpts.fallbackModel = stripOllama(dynamicGroupCfg.classifier_fallback);
        // Cloud ref is NOT ollama-stripped — findModel needs the full
        // "provider/id" form to resolve it against pi's model registry.
        if (dynamicGroupCfg?.classifier_cloud_model) classifyOpts.pinnedCloudModel = dynamicGroupCfg.classifier_cloud_model;

        const classification = await this.ctx.classifyPrompt(prompt ?? '', classifyOpts);

        if ('category' in classification) {
          this.ctx.lastClassifiedCategory = classification.category;
        }

        // HINT override
        if ('hintType' in classification) {
          if (classification.hintType === 'group') {
            const res = this.ctx.resolve(classification.hintTarget);
            if (res) {
              const hintSeen = new Set<string>(res.candidates);
              const hintFallbacks = cfg.model_groups[classification.hintTarget]?.fallback_groups ?? [];
              for (const fbGroup of hintFallbacks) {
                const fbRes = this.ctx.resolve(fbGroup);
                if (!fbRes) continue;
                for (const ref of fbRes.candidates) {
                  if (!hintSeen.has(ref)) { hintSeen.add(ref); res.candidates.push(ref); }
                }
              }
              candidates = [...res.candidates];
              this.ctx.lastDynamicModel = res.selected;
              dynamicLabel = `HINT: ${classification.hintTarget} → ${res.selected}`;
              const logLine = `${new Date().toISOString()}  ${dynamicLabel}  "${(prompt ?? '').slice(0, 80).replace(/\n/g, ' ')}"`;
              appendRawLog(logLine);
              // Cost tracking moved to turn_end (review I2 — hardcoded
              // 1000/500 here were fabricated audit data).
              await this.driveStream(
                proxy,
                candidates,
                context,
                options,
                dynamicLabel,
                classification.hintTarget,
                undefined,
                sourceModel
              );
              return;
            }
            const hintedGroup = cfg.model_groups[classification.hintTarget];
            if (hintedGroup?.method === 'dynamic') {
              routerLog(`[dynamic] HINT targets the dynamic group itself — falling through to normal classification: ${classification.hintTarget}`);
            } else {
              routerLog(`[dynamic] HINT group not found: ${classification.hintTarget}`);
            }
          } else if (classification.hintType === 'model') {
            const shortName = classification.hintTarget;
            let hintSiblings: string[] = [];
            const bareName = shortName.includes('/')
              ? shortName.slice(shortName.lastIndexOf('/') + 1)
              : shortName;
            const matches: string[] = [];
            const addMatch = (ref: string) => {
              if (ref && !matches.includes(ref)) matches.push(ref);
            };
            // Exact match first, then separator-normalized second chance
            // (2026-09-20: "zai-glm-5.3"/"zai-glm-5_3" must resolve to
            // "zai-glm-5-3" — exact-only matching made every HINT variant
            // fail with "not found; using as-is").
            const namesMatch = (ref: string) =>
              ref === shortName || ref.endsWith('/' + bareName) || hintTargetMatches(shortName, ref);
            for (const ref of router.allDiscoveredRefs()) {
              if (namesMatch(ref)) addMatch(ref);
            }
            if (this.ctx.sessionCtx?.modelRegistry) {
              const knownProviders = new Set<string>([
                ...Object.keys(PROVIDER_MAP),
                ...Object.keys(cfg.providers ?? {}),
                ...router.allDiscoveredRefs().map(ref => ref.split('/')[0]),
              ]);
              const normalizedBare = normalizeHintName(bareName);
              for (const provider of knownProviders) {
                const model =
                  this.ctx.sessionCtx.modelRegistry.find(provider, bareName) ??
                  (normalizedBare !== bareName
                    ? this.ctx.sessionCtx.modelRegistry.find(provider, normalizedBare)
                    : undefined);
                if (model) addMatch(`${provider}/${model.id}`);
              }
            }
            if (!matches.length) {
              const allGroupModels: string[] = [];
              for (const [groupName] of Object.entries(cfg.model_groups)) {
                try {
                  const { models } = router.getTopModels(groupName, 100);
                  for (const item of models) allGroupModels.push(item.ref);
                } catch (_) { /* ignore */ }
              }
              const viaGroups = resolveShortModelName(bareName, allGroupModels);
              if (viaGroups) { addMatch(viaGroups); routerLog(`[dynamic] HINT: resolved "${shortName}" to "${viaGroups}" via group scan`); }
            }
            if (matches.length) {
              const ranked = await rankHintCandidates(
                matches,
                cfg.model_groups,
                this.ctx.sessionCtx?.modelRegistry,
                this.ctx.lookupGdp,
                (unusable) => routerLog(`[dynamic] HINT: skipping unusable refs (no handler/credentials): ${unusable.join(', ')}`)
              );
              if (shortName.includes('/') && matches.includes(shortName) && await isRefUsable(shortName, cfg.model_groups, this.ctx.sessionCtx?.modelRegistry)) {
                hintSiblings = [shortName, ...ranked.filter(r => r !== shortName)];
              } else {
                hintSiblings = ranked;
              }
              candidates = [...hintSiblings];
              const isExplicitHint = classification.origin !== 'auto';
              if (isExplicitHint) {
                candidates.forEach(ref => this.ctx.clearLimit(ref));
              }
              if (this.ctx.sessionCtx?.modelRegistry) {
                const availableModels = this.ctx.sessionCtx.modelRegistry
                  .getAvailable()
                  .map((m: any) => `${m.provider}/${m.id}` as string)
                  .filter((ref: string) => {
                    if (isBlocked(cache, ref)) return false;
                    if (!cfg.exclude) return true;
                    return !isExcluded(ref, { rules: cfg.exclude, cfg, cache });
                  });
                const sortedByGdpval = [...availableModels].sort((a, b) => {
                  const gA = this.ctx.lookupGdp(a) ?? 0;
                  const gB = this.ctx.lookupGdp(b) ?? 0;
                  return gB - gA;
                });
                const fallbackPool = sortedByGdpval.filter(ref => !candidates.includes(ref));
                const fallbackUsability = await Promise.all(
                  fallbackPool.map(ref => isRefUsable(ref, cfg.model_groups, this.ctx.sessionCtx.modelRegistry))
                );
                const fallbackCandidates = fallbackPool.filter((_, i) => fallbackUsability[i]).slice(0, 5);
                if (fallbackCandidates.length) {
                  routerLog(`[dynamic] HINT fallback candidates: ${fallbackCandidates.join(', ')}`);
                  candidates.push(...fallbackCandidates);
                }
              }
              this.ctx.lastDynamicModel = hintSiblings[0];
              // MHINT (not HINT): the router's OWN model-hint narration must
              // never collide with the user's reserved "HINT:" channel —
              // quoted narration re-read as a fresh HINT locked a session
              // into one model for hours (2026-09-18 incident).
              dynamicLabel = `MHINT: ${classification.hintTarget}`;
              const logLine = `${new Date().toISOString()}  ${dynamicLabel}  ${hintSiblings[0]}  "${(prompt ?? '').slice(0, 80).replace(/\n/g, ' ')}"`;
              appendRawLog(logLine);
              // Cost tracking moved to turn_end (review I2 — hardcoded
              // 1000/500 here were fabricated audit data).
              const resolvedGdpval = this.ctx.lookupGdp(hintSiblings[0]) ?? 0;
              const hintStartGroup = resolvedGdpval >= 700 ? 'strategic' : resolvedGdpval >= 300 ? 'tactical' : 'scout';
              await this.driveStream(proxy, candidates, context, options, dynamicLabel, hintStartGroup, undefined, sourceModel);
              return;
            } else {
              // Final v1.6.0 review (Minor): this branch used to log "using
              // as-is" and assign candidates/lastDynamicModel/dynamicLabel
              // for a direct use of the unknown name — but every one of those
              // assignments was dead: the normal-classification block below
              // unconditionally overwrites candidates/lastDynamicModel/
              // dynamicLabel. The ACTUAL behavior (verified in the 2026-09-20
              // "zai-glm-5.3" incident) is fall-through to normal
              // classification, so the log now says what really happens.
              routerLog(`[dynamic] HINT model "${shortName}" not found in any group, registry or provider; falling back to normal classification`);
            }
          }
        }

        const normalClassification = classification as ClassificationResult;
        let targetGroup: string;
        if (this.ctx.escalation.level !== 'operational') {
          targetGroup = this.ctx.escalation.level;
          routerLog(`[escalation] Using escalated group: ${targetGroup}`);
        } else {
          targetGroup = this.ctx.getGroupForCategory(normalClassification.category);
        }

        let res = this.ctx.resolve(targetGroup);
        resolvedGroup = targetGroup;
        if (!res) { res = this.ctx.resolve('fallback'); resolvedGroup = 'fallback'; }
        if (!res) throw new Error(`No models for dynamic target "${targetGroup}"`);

        const seen = new Set<string>(res.candidates);
        const fallbackCandidates: string[] = [];
        const groupFallbacks = cfg.model_groups[targetGroup]?.fallback_groups ?? [];
        for (const fbGroup of groupFallbacks) {
          const fbRes = this.ctx.resolve(fbGroup);
          if (!fbRes) continue;
          for (const ref of fbRes.candidates) {
            if (!seen.has(ref)) { seen.add(ref); fallbackCandidates.push(ref); }
          }
        }

        candidates = [...res.candidates, ...fallbackCandidates];
        this.ctx.lastDynamicModel = res.selected;
        dynamicLabel = `${normalClassification.category} → ${targetGroup}`;
        const logLine = `${new Date().toISOString()}  ${dynamicLabel}  ${res.selected}  "${(prompt ?? '').slice(0, 80).replace(/\n/g, ' ')}"`;
        appendRawLog(logLine);
        // Cost tracking moved to turn_end (review I2 — hardcoded
        // 1000/500 here were fabricated audit data).
      } catch (err) {
        routerLog('[dynamic] classification failed, using fallback:', err);
        resolvedGroup = 'fallback';
        let fb = this.ctx.resolve('fallback');
        if (!fb) {
          const alt = Object.keys(cfg.model_groups).find(
            (k) => cfg.model_groups[k].method !== 'dynamic'
          )!;
          resolvedGroup = alt;
          fb = this.ctx.resolve(alt);
        }
        if (!fb) {
          pushStreamError(
            proxy,
            `[router] Dynamic routing failed: ${err}`,
            '[router] dynamic classification and fallback routing both unavailable',
            sourceModel
          );
          return;
        }
        candidates = [...fb.candidates];
      }
      await this.driveStream(proxy, candidates, context, options, dynamicLabel, resolvedGroup, undefined, sourceModel);
    })();
    return proxy;
  }

  // ── driveStream ──────────────────────────────────────────────────────────

  async driveStream(
    proxy: AssistantMessageEventStream,
    candidates: string[],
    context: Context,
    options: SimpleStreamOptions | undefined,
    label?: string,
    groupName?: string,
    visitedGroups?: Set<string>,
    sourceModel?: SourceModelInfo
  ): Promise<void> {
    const ctx = this.ctx;
    if (ctx.activeGroup) ctx.router.setActiveGroup(ctx.activeGroup);

    let lastError: string | undefined;
    const allErrors: { ref: string; message: string }[] = [];
    const pushError = (ref: string, message: string): void => {
      lastError = `${ref}: ${message}`;
      allErrors.push({ ref, message });
    };

    let contextOverflowSkips = 0;
    // Bounded wait-for-reset: at most ONE wait-and-retry per driveStream call,
    // so a chain of short-reset rate limits can't turn the wait path into a
    // livelock (each wait retries the SAME model once, then falls through to
    // the normal cascade).
    let rateLimitWaitUsed = false;
    let cooldownSkips = 0;
    const contextTokens = ctx.estimateContextTokens(context);

    for (let i = 0; i < candidates.length; i++) {
      const ref = candidates[i];
      if (ctx.isLimited(ref)) {
        pushError(ref, `skipped, still in cooldown (${ctx.router.limitSecs(ref)}s remaining)`);
        cooldownSkips++;
        continue;
      }
      if (ctx.isProviderWedged(ref)) {
        pushError(ref, 'skipped, local provider looks wedged (watchdog)');
        cooldownSkips++;
        continue;
      }
      const ctxWindow = ctx.getModelContextWindow(ref);
      if (ctxWindow && contextTokens > ctxWindow) {
        pushError(ref, `skipped, context window ${ctxWindow} < ${contextTokens} tokens needed`);
        contextOverflowSkips++;
        continue;
      }
      const attempt = openCandidateAttempt(options);
      // S1 (final v1.6.0 review): set by the catch below when the failure has
      // ALREADY been recorded. The `!target` block used to record a second,
      // identical provider_error for the same thrown open — two ring-buffer
      // entries + two soft-failure hits per real failure, breaking the
      // "⚠N err == N events" footer contract and doubling the backoff
      // cadence. `!target` must only record the SILENT-skip path (tryStream
      // returned null with a skipReason and never threw).
      let openFailureText: string | undefined;
      const target = await ctx.tryStream(ref, context, attempt.options).catch((err) => {
        const errorMsg = String(err.message || err);
        const isExpectedError = isExpectedTransientError(errorMsg);
        if (!isExpectedError) routerLog(`[router] Skipping ${ref}: ${errorMsg}`);
        pushError(ref, errorMsg);
        // Routed through recordStreamFailure (review round 2, Finding 1):
        // every main-loop failure must reach the session_errors ring buffer,
        // not just the rate-limit sites. The seam evaluates
        // isPaidCloudRateLimitFailure on the error text — a 429-shaped open
        // failure now correctly takes the hard path instead of a soft hop.
        openFailureText = errorMsg;
        ctx.recordStreamFailure(ref, 'provider_error', undefined, errorMsg);
        pushRouterInfoLogged(proxy, `> [router] Trying next model (${ref} unavailable: ${errorMsg})\n\n`);
        return null;
      });
      if (!target) {
        attempt.abandon();
        if (openFailureText === undefined) {
          // Silent-skip path: tryStream returned null without throwing
          // (no API key, local concurrency limit, ...) — skipReason carries
          // the cause; record THIS failure exactly once.
          const why = ctx.skipReasons.get(ref);
          if (why) pushError(ref, why);
          ctx.recordStreamFailure(ref, 'provider_error', undefined, why ? String(why) : undefined);
        }
        continue;
      }

      const prefix = label ? `${label} · ${ref}` : ref;
      pushRouterInfoLogged(proxy, `> [router] ${prefix}\n\n`);
      ctx.router.setCurModel(ref);
      ctx.router.setActiveGroup(ctx.activeGroup);
      ctx.curModel = ref;
      ctx.lastDynamicModel = ref;

      let attemptSucceeded = false;
      try {
        const result = await ctx.consumeWithDetection(
          target.stream, proxy,
          ctx.getEmptyResponseTimeout(ref),
          ctx.getStallTimeout(ref),
          String(ref)
        );

        if (result.ok) {
          attemptSucceeded = true;
          ctx.recordOk(ref);
          return;
        }
        if (result.reason === 'aborted') return;
        if (result.reason === 'provider_error' && result.detail) ctx.observeFailure(ref, result.detail);

        if (result.reason === 'rate_limit_exceeded') {
          const rlResult = ctx.recordStreamFailure(ref, String(result.reason), result.resetAtMs, result.detail);
          pushError(ref, 'rate_limit_exceeded');
          const keyMsg = rlResult.rotated ? ` (key rotated to ${rlResult.newKey})` : '';
          const resetMsg = ctx.formatResetMsg(ref, result.resetAtMs, rlResult.rotated);

          // Bounded wait-for-reset: when the provider TOLD us when the limit
          // clears and that moment is near, waiting beats burning the whole
          // chain. Without this, a short window (Mistral TPM "Try again in
          // 60s", 2026-09-27 incident) makes the cascade record failures on
          // every other candidate; the next request repeats the burn, and
          // within minutes all candidates sit on escalated cooldowns while
          // the originally limited model has long been available again.
          const waitMaxMs = ctx.getRateLimitWaitMaxMs();
          const resetInMs = result.resetAtMs && Number.isFinite(result.resetAtMs)
            ? result.resetAtMs - Date.now()
            : -1;
          if (!rlResult.rotated && waitMaxMs > 0 && !rateLimitWaitUsed
              && resetInMs > 0 && resetInMs <= waitMaxMs) {
            rateLimitWaitUsed = true;
            const waitSecs = Math.ceil(resetInMs / 1000);
            routerLog(
              `[router] ${ref} rate-limited with known near reset — waiting ${waitSecs}s, then retrying the same model (rate_limit_wait_max_ms=${waitMaxMs})`
            );
            pushRouterInfoLogged(
              proxy,
              `> [router] ${ref} — rate limited${resetMsg} — waiting ${waitSecs}s, then retrying…\n\n`
            );
            await sleepMs(resetInMs + 2000);
            const retryAttempt = openCandidateAttempt(options);
            const retryTarget = await ctx.tryStream(ref, context, retryAttempt.options).catch(() => null);
            if (!retryTarget) retryAttempt.abandon();
            if (retryTarget) {
              let retrySucceeded = false;
              try {
                const retryResult = await ctx.consumeWithDetection(
                  retryTarget.stream, proxy,
                  ctx.getEmptyResponseTimeout(ref),
                  ctx.getStallTimeout(ref),
                  String(ref)
                );
                if (retryResult.ok) {
                  retrySucceeded = true;
                  ctx.recordOk(ref);
                  return;
                }
                if (retryResult.reason === 'aborted') return;
                // Feed the blocklist observer like the main loop does, so a
                // provider_error seen during the post-wait retry (e.g. a bare
                // 422) still counts toward the learned-blocklist streaks.
                if (retryResult.reason === 'provider_error' && retryResult.detail) ctx.observeFailure(ref, retryResult.detail);
                // Still failing after the reset window — record it, tell the
                // user, and fall through to the normal cascade.
                ctx.recordStreamFailure(ref, String(retryResult.reason), retryResult.resetAtMs, retryResult.detail);
                pushError(ref, `still failing after wait: ${retryResult.reason}`);
                pushRouterInfoLogged(
                  proxy,
                  `> [router] ${ref} — still failing after waiting (${retryResult.reason}), trying next…\n\n`
                );
              } finally {
                if (!retrySucceeded) retryAttempt.abandon();
                ctx.releaseLocalSlot(ref);
              }
            }
            continue;
          }

          const nextRef = candidates.slice(i + 1).find(r => !ctx.isLimited(r));
          const suffix = nextRef ? `, trying ${nextRef} …` : '';
          pushRouterInfoLogged(proxy, `> [router] ${ref} — rate limit/spend limit reached${resetMsg}${keyMsg}${suffix}\n\n`);
          continue;
        }
        if (result.reason === 'context_overflow') {
          const errInfo = extractContextWindowFromError(result.detail);

          // Update the registry with the real context window so future requests
          // don't try this model for the current (or similar) context size.
          if (errInfo) {
            ctx.updateModelContextWindow(ref, errInfo.actualContextWindow);
            routerLog(
              `[router] ${ref} context window is ${errInfo.actualContextWindow.toLocaleString()} tokens (discovered from overflow error; prompt was ${errInfo.requestedTokens.toLocaleString()} tokens)`
            );
          }

          // Filter remaining candidates to those with enough context window.
          // If the error gave us the real numbers, use them (much more accurate
          // than our token estimate). Otherwise fall back to the estimate.
          const minNeeded = errInfo?.requestedTokens ?? contextTokens;
          const largerCandidates = candidates.slice(i + 1).filter((r) => {
            const cw = ctx.getModelContextWindow(r);
            return !cw || cw > minNeeded;
          });

          // Try larger-context models first before giving up.
          if (largerCandidates.length > 0) {
            // Record the overflow as a soft failure so cooldown excludes this
            // model from the retry pass — guarding against unbounded recursion
            // when the error text is unparseable (errInfo === null) and the
            // registry update didn't happen (via the recordStreamFailure
            // seam, which also feeds the session_errors buffer — review
            // round 2, Finding 1).
            ctx.recordStreamFailure(ref, 'context_overflow', undefined, result.detail);
            // Don't re-include the overflowing model: it's already known too
            // small (parseable) or on cooldown (unparseable). Slicing past i
            // + the larger candidates avoids retrying the same overflow.
            const tried = [...largerCandidates];
            const label2 = label ? `${label} (context overflow → trying larger)` : `${groupName ?? ref} (context overflow → trying larger)`;
            pushRouterInfoLogged(
              proxy,
              `> [router] ${ref} context window (${errInfo?.actualContextWindow.toLocaleString() ?? '?'} tokens) < ${minNeeded.toLocaleString()} needed — trying ${largerCandidates.length} larger model(s)…\n\n`
            );
            await this.driveStream(
              proxy, tried, context, options, label2,
              groupName, undefined, sourceModel
            );
            return;
          }

          // No larger candidates remain — this is a genuine overflow.
          pushError(ref, 'context_overflow (provider rejected prompt as too large)');
          ctx.recordStreamFailure(ref, 'context_overflow', undefined, result.detail);
          pushStreamError(
            proxy,
            `[router] ${ref} rejected the prompt as too large for its context window — triggering compaction.`,
            result.detail
              ? `prompt is too long: ${result.detail}`
              : `prompt is too long: ${contextTokens} tokens exceeds the maximum context length of available models`,
            sourceModel
          );
          return;
        }
        if (result.reason === 'repetition_loop') {
          pushError(ref, `repetition_loop (${result.detail ?? 'stuck repeating output'})`);
          ctx.recordStreamFailure(ref, 'repetition_loop', undefined, result.detail);
          const nextRef = candidates.slice(i + 1).find(r => !ctx.isLimited(r));
          const suffix = nextRef ? `, trying ${nextRef} …` : '';
          pushRouterInfoLogged(
            proxy,
            `> [router] ${ref} — stuck in a repetition loop (${result.detail ?? 'loop detected'})${suffix}\n\n`
          );
          continue;
        }
        if (result.reason === 'truncated_length') {
          pushError(ref, 'truncated_length (hit max output tokens — answer incomplete)');
          ctx.recordStreamFailure(ref, 'truncated_length');
          const nextRef = candidates.slice(i + 1).find(r => !ctx.isLimited(r));
          const suffix = nextRef ? `, trying ${nextRef} …` : '';
          pushRouterInfoLogged(
            proxy,
            `> [router] ${ref} — output truncated at max tokens (task incomplete)${suffix}\n\n`
          );
          continue;
        }
        // Pass the error detail: since provider_error became text-gated
        // (2026-09-27), the guard without it could never see a 429/402 and
        // would wrongly route genuine rate-limit provider errors into the
        // soft branch while recordStreamFailure (which does get the detail)
        // would have escalated them — the two sites must stay in sync.
        if (isPaidCloudRateLimitFailure(ref, String(result.reason), result.detail)) {
          const rlResult = ctx.recordStreamFailure(ref, String(result.reason), result.resetAtMs, result.detail);
          pushError(ref, `${result.reason} (treated as rate-limit)`);
          const nextRef = candidates.slice(i + 1).find(r => !ctx.isLimited(r));
          const suffix = nextRef ? `, trying ${nextRef} …` : '';
          const keyMsg = rlResult.rotated ? ` (key rotated to ${rlResult.newKey})` : '';
          const paidLabel = result.reason === 'stall_timeout'
            ? 'stream stalled (likely rate limit)'
            : result.reason === 'provider_error'
              ? `provider error${result.detail ? `: ${result.detail}` : ''} (likely rate limit)`
              : 'empty response (likely rate limit)';
          const resetMsg = ctx.formatResetMsg(ref, result.resetAtMs, rlResult.rotated);
          pushRouterInfoLogged(proxy, `> [router] ${ref} — ${paidLabel}${resetMsg}${keyMsg}${suffix}\n\n`);
          continue;
        }
        // Soft failure — through the seam so it reaches the ring buffer
        // too (review round 2, Finding 1). isPaidCloudRateLimitFailure was
        // evaluated FALSE just above with the SAME reason+detail, so this is
        // deterministically soft here.
        pushError(ref, String(result.reason));
        ctx.recordStreamFailure(ref, String(result.reason), result.resetAtMs, result.detail);
        if (
          (result.reason === 'empty_timeout' || result.reason === 'stall_timeout') &&
          ctx.observeLocalTimeout(ref)
        ) {
          const provider = ref.split('/')[0];
          pushRouterInfoLogged(
            proxy,
            `> [router] ${provider} looks wedged: generations time out on several local models while the daemon still answers. ` +
              `Skipping ${provider} models for ${WEDGE_COOLDOWN_TEXT}. Fix: ${wedgeFixHint(provider)}.\n\n`
          );
        }
        const reason = result.reason === 'empty_timeout'
          ? 'no response within timeout'
          : result.reason === 'stall_timeout'
            ? 'stream stalled mid-response'
            : result.reason === 'provider_error'
              ? `provider error${result.detail ? `: ${result.detail}` : ''}`
              : 'empty response from model';
        const nextRef = candidates.slice(i + 1).find(r => !ctx.isLimited(r));
        const suffix = nextRef ? `, trying ${nextRef} …` : '';
        pushRouterInfoLogged(proxy, `> [router] ${ref} — ${reason}${suffix}\n\n`);
      } catch (streamError) {
        const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
        pushError(ref, errorMsg);
        ctx.observeFailure(ref, errorMsg);
        // Seam (review round 2, Finding 1): stream exceptions must land in
        // the session_errors buffer as well — this catch is where the
        // 2026-09-27 422/timeout waves would have been invisible.
        ctx.recordStreamFailure(ref, 'provider_error', undefined, errorMsg);
        const nextRef = candidates.slice(i + 1).find(r => !ctx.isLimited(r));
        const suffix = nextRef ? `, trying ${nextRef} …` : '';
        pushRouterInfoLogged(proxy, `> [router] ${ref} — error: ${errorMsg}${suffix}\n\n`);
      } finally {
        // Cancel the provider-side work of every attempt that did not win
        // (see openCandidateAttempt) — including timeouts, where the
        // upstream is otherwise still running.
        if (!attemptSucceeded) attempt.abandon();
        // Release the local concurrency slot acquired in tryStream. Must
        // run on every path: success (return), soft-failure (continue),
        // and hard-failure (catch). Cloud providers were never counted and
        // are never released — guarded by isLocalProvider(ref).
        ctx.releaseLocalSlot(ref);
      }
    }

    // Fallback cascade
    const allFailed = allErrors.length > 0;
    if (allFailed && groupName) {
      const visited = visitedGroups ?? new Set<string>();
      visited.add(groupName);
      const fallbackGroup = getFallbackGroup(groupName, ctx.cfg.model_groups, visited);
      if (fallbackGroup) {
        const fb = ctx.resolve(fallbackGroup);
        if (fb?.candidates?.length) {
          pushRouterInfoLogged(proxy, `> [router] All models in ${groupName} failed, trying ${fallbackGroup}...\n\n`);
          await this.driveStream(
            proxy, fb.candidates, context, options,
            `${label ?? groupName}→${fallbackGroup}`, fallbackGroup, visited, sourceModel
          );
          return;
        }
      }
    }

    // Context-overflow short-circuit
    if (allFailed && contextOverflowSkips > 0 && contextOverflowSkips === allErrors.length) {
      pushStreamError(
        proxy,
        `[router] Conversation (${contextTokens} tokens) exceeds every available model's context window — triggering compaction.`,
        `prompt is too long: ${contextTokens} tokens exceeds the maximum context length of available models`,
        sourceModel
      );
      return;
    }

    // Total cooldown collapse.
    // The original strict-equality check (`cooldownSkips === allErrors.length`)
    // misses an important case: when N-1 candidates are pre-skipped as in
    // cooldown and the Nth is tried LIVE, hits a fresh 429, and records its
    // OWN cooldown via recordStreamFailure, then cooldownSkips = N-1 but
    // allErrors.length = N, so the strict equality fails and the router
    // hard-fails instead of retrying the shortest-cooldown candidate.
    // Fix: check whether EVERY candidate is CURRENTLY in cooldown (via
    // isLimited), which captures both the pre-skipped ones AND any candidate
    // whose live failure just put it into cooldown. This is strictly more
    // robust than the counter equality.
    //
    // Deliberate invariant: a ref skipped purely via the context-window guard
    // ("context window too small" short-circuit, ~line 481) does NOT call
    // recordSoftFailure, so ctx.isLimited() stays false for it and it opts
    // out of this collapse condition. That's correct — a context-overflow
    // skip is not a rate-limit cooldown, and a mixed batch (one ctx-too-small
    // + the rest rate-limited) should NOT trigger the cooldown safety net
    // (the ctx-too-small ref has nothing to retry). Kept this way on purpose;
    // a future refactor of the skip logic must preserve this distinction.
    const allInCooldownNow = allFailed && candidates.every((r) => ctx.isLimited(r));
    if (allInCooldownNow && candidates.length > 0) {
      let bestRef: string | null = null;
      let bestSecs = Number.POSITIVE_INFINITY;
      for (const ref of candidates) {
        const secs = ctx.router.limitSecs(ref);
        if (secs < bestSecs) { bestSecs = secs; bestRef = ref; }
      }
      if (bestRef) {
        // Wait for the shortest cooldown instead of force-retrying into a
        // KNOWN-unexpired cooldown. The old immediate force-retry was
        // self-poisoning: it re-tried a model whose own cooldown said "wait
        // Ns", the guaranteed failure recorded ANOTHER hit, and the
        // escalating backoff pushed cooldowns far past the provider's real
        // recovery — the 2026-09-27 incident where the router stayed dead for
        // minutes while the API had long been fine (hard-selecting the model
        // worked, proving the state machine had diverged from reality).
        // Bounded by getRateLimitWaitMaxMs; long remaining times keep the old
        // immediate force-retry semantics.
        const waitMaxMs = ctx.getRateLimitWaitMaxMs();
        if (waitMaxMs > 0 && bestSecs * 1000 <= waitMaxMs) {
          routerLog(
            `[router] Total cooldown collapse — all ${candidates.length} candidate(s) in cooldown. Waiting ${bestSecs}s for ${bestRef} (shortest cooldown), then retrying.`
          );
          pushRouterInfoLogged(
            proxy,
            `> [router] All models in cooldown — waiting ${bestSecs}s for ${bestRef} (shortest cooldown), then retrying…\n\n`
          );
          await sleepMs(bestSecs * 1000 + 2000);
        } else {
          routerLog(
            `[router] Total cooldown collapse — all ${candidates.length} candidate(s) in cooldown. Force-retrying ${bestRef} (${bestSecs}s remaining).`
          );
          pushRouterInfoLogged(
            proxy,
            `> [router] All models in cooldown, retrying ${bestRef} (shortest cooldown, ${bestSecs}s)...\n\n`
          );
        }
        ctx.router.setCurModel(bestRef);
        ctx.router.setActiveGroup(ctx.activeGroup);
        ctx.curModel = bestRef;
        ctx.lastDynamicModel = bestRef;
        const collapseAttempt = openCandidateAttempt(options);
        const target = await ctx.tryStream(bestRef, context, collapseAttempt.options).catch((err) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          pushError(bestRef!, errorMsg);
          ctx.recordStreamFailure(bestRef!, 'provider_error', undefined, errorMsg);
          return null;
        });
        if (!target) collapseAttempt.abandon();
        if (target) {
          let collapseSucceeded = false;
          try {
            const result = await ctx.consumeWithDetection(
              target.stream, proxy,
              ctx.getEmptyResponseTimeout(bestRef),
              ctx.getStallTimeout(bestRef),
              bestRef as string
            );
            if (result.ok) {
              collapseSucceeded = true;
              ctx.recordOk(bestRef);
              return;
            }
            if (result.reason === 'aborted') return;
            if (result.reason === 'provider_error' && result.detail) ctx.observeFailure(bestRef, result.detail);
            pushError(bestRef, String(result.reason));
            if (result.reason === 'context_overflow') {
              ctx.recordStreamFailure(bestRef, 'context_overflow', undefined, result.detail);
              pushStreamError(
                proxy,
                `[router] ${bestRef} rejected the prompt as too large for its context window — triggering compaction.`,
                result.detail
                  ? `prompt is too long: ${result.detail}`
                  : `prompt is too long: ${contextTokens} tokens exceeds the maximum context length`,
                sourceModel
              );
              return;
            }
            if (result.reason === 'repetition_loop' || result.reason === 'truncated_length') {
              ctx.recordStreamFailure(bestRef, String(result.reason), undefined, result.detail);
              pushRouterInfoLogged(
                proxy,
                `> [router] ${bestRef} — ${result.reason === 'repetition_loop' ? 'stuck in a repetition loop' : 'output truncated at max tokens (task incomplete)'}\n\n`
              );
            } else {
              const frResult = ctx.recordStreamFailure(bestRef, String(result.reason), result.resetAtMs, result.detail);
              if (frResult.hardLimited) {
                const keyMsg = frResult.rotated ? ` (key rotated to ${frResult.newKey})` : '';
                const reasonTxt = String(result.reason);
                const labelTxt = reasonTxt === 'rate_limit_exceeded'
                  ? 'rate limit/spend limit reached'
                  : reasonTxt === 'stall_timeout'
                    ? 'stream stalled (likely rate limit)'
                    : reasonTxt === 'provider_error'
                      ? `provider error${result.detail ? `: ${result.detail}` : ''} (likely rate limit)`
                      : 'empty response (likely rate limit)';
                const resetMsg = ctx.formatResetMsg(bestRef!, result.resetAtMs, frResult.rotated);
                pushRouterInfoLogged(proxy, `> [router] ${bestRef} — ${labelTxt}${resetMsg}${keyMsg}\n\n`);
              }
            }
          } catch (streamError) {
            const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
            pushError(bestRef, errorMsg);
            ctx.observeFailure(bestRef, errorMsg);
            ctx.recordStreamFailure(bestRef, 'provider_error', undefined, errorMsg);
          } finally {
            if (!collapseSucceeded) collapseAttempt.abandon();
            // Release the local concurrency slot acquired in tryStream for
            // the force-retry candidate. Same guard as the main loop's finally.
            ctx.releaseLocalSlot(bestRef);
          }
        }
      }
    }

    // All candidates exhausted
    if (allErrors.length > 0) {
      const failureLines = allErrors.map(({ ref, message }) => `  • ${ref}: ${message}`).join('\n');
      const overflowLine = allErrors.some(({ message }) => isOverflowErrorText(message) || isOverflowDeltaText(message))
        ? '\n(Detected overflow in stream — Pi should compact and retry.)'
        : '';
      const errorMsg = `[router] All ${allErrors.length} candidate(s) failed:\n${failureLines}${overflowLine}`;
      routerLog(`[router] All ${allErrors.length} candidate(s) failed for group ${groupName ?? label ?? '?'}`);
      pushStreamError(
        proxy,
        errorMsg,
        `[router] All ${allErrors.length} candidate(s) failed.`,
        sourceModel
      );
    }
  }

  // ── Private helpers (exclusively used by groupStream/driveStream) ──────

  private extractPreviousUserMessage(context: Context): string | undefined {
    // Stripped of router narration (see stripRouterNarration in ./utils.ts) as
    // defense in depth: this feeds the classifier's "Context" block, which the
    // prompt already instructs the classifier to never read a HINT from, but a
    // weak/local classifier model can still misread "HINT: <model>" wherever
    // it appears in the combined prompt text.
    try {
      const userMsgs = context.messages.filter((m: any) => m.role === 'user');
      const prev = userMsgs[userMsgs.length - 2];
      if (!prev) return undefined;
      const c = prev.content;
      if (typeof c === 'string') return stripRouterNarration(c).slice(0, 150);
      if (Array.isArray(c)) {
        const textContent = (c as any[])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text as string)
          .join('');
        return stripRouterNarration(textContent).slice(0, 150);
      }
    } catch { /* context shape unknown */ }
    return undefined;
  }
}
