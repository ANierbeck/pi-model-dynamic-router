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
import { resolveShortModelName } from './utils.ts';
import { rankHintCandidates, isRefUsable } from './hint-resolution.ts';
import { getFallbackGroup } from './routing.ts';
import { PROVIDER_MAP } from './providers.ts';
import { isExcluded } from './exclude.ts';
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
  costTracker: CostTracker;
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
  consumeWithDetection: (
    stream: AssistantMessageEventStream,
    proxy: AssistantMessageEventStream,
    emptyResponseTimeoutMs: number,
    stallTimeoutMs: number
  ) => Promise<{ ok: boolean; reason?: string; resetAtMs?: number; detail?: string | undefined }>;
  isLocalProvider: (ref: string) => boolean;
  localStreamLimit: () => number;
  releaseLocalSlot: (ref: string) => void;
  recordSoftFailure: (ref: string) => void;
  recordOk: (ref: string) => void;
  recordStreamFailure: (
    ref: string,
    reason: string,
    resetAtMs?: number
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
    const { cfg, cache, router, costTracker } = this.ctx;
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
      costTracker.trackRequest(res.selected, 1000, 500);
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
          completeSimple: (model: any, ctx: any, options: any) =>
            this.ctx.sessionCtx?.modelRegistry?.completeSimple?.(model, ctx, options),
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
              costTracker.trackRequest(res.selected, 1000, 500);
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
            const namesMatch = (ref: string) =>
              ref === shortName || ref.endsWith('/' + bareName) || ref.split('/').pop() === bareName;
            for (const ref of router.allDiscoveredRefs()) {
              if (namesMatch(ref)) addMatch(ref);
            }
            if (this.ctx.sessionCtx?.modelRegistry) {
              const knownProviders = new Set<string>([
                ...Object.keys(PROVIDER_MAP),
                ...Object.keys(cfg.providers ?? {}),
                ...router.allDiscoveredRefs().map(ref => ref.split('/')[0]),
              ]);
              for (const provider of knownProviders) {
                const model = this.ctx.sessionCtx.modelRegistry.find(provider, bareName);
                if (model) addMatch(`${provider}/${model.id}`);
              }
            }
            if (!matches.length) {
              const allGroupModels: string[] = [];
              for (const [groupName] of Object.entries(cfg.model_groups)) {
                try {
                  for (const item of router.getTopModels(groupName, 100)) allGroupModels.push(item.ref);
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
              dynamicLabel = `HINT: ${classification.hintTarget}`;
              const logLine = `${new Date().toISOString()}  ${dynamicLabel}  ${hintSiblings[0]}  "${(prompt ?? '').slice(0, 80).replace(/\n/g, ' ')}"`;
              appendRawLog(logLine);
              costTracker.trackRequest(hintSiblings[0], 1000, 500);
              const resolvedGdpval = this.ctx.lookupGdp(hintSiblings[0]) ?? 0;
              const hintStartGroup = resolvedGdpval >= 700 ? 'strategic' : resolvedGdpval >= 300 ? 'tactical' : 'scout';
              await this.driveStream(proxy, candidates, context, options, dynamicLabel, hintStartGroup, undefined, sourceModel);
              return;
            } else {
              routerLog(`[dynamic] HINT model "${shortName}" not found; using as-is`);
              candidates = [shortName];
              this.ctx.lastDynamicModel = shortName;
              dynamicLabel = `HINT: ${classification.hintTarget}`;
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
        costTracker.trackRequest(res.selected, 1000, 500);
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
    let cooldownSkips = 0;
    const contextTokens = ctx.estimateContextTokens(context);

    for (let i = 0; i < candidates.length; i++) {
      const ref = candidates[i];
      if (ctx.isLimited(ref)) {
        pushError(ref, `skipped, still in cooldown (${ctx.router.limitSecs(ref)}s remaining)`);
        cooldownSkips++;
        continue;
      }
      const ctxWindow = ctx.getModelContextWindow(ref);
      if (ctxWindow && contextTokens > ctxWindow) {
        pushError(ref, `skipped, context window ${ctxWindow} < ${contextTokens} tokens needed`);
        contextOverflowSkips++;
        continue;
      }
      const target = await ctx.tryStream(ref, context, options).catch((err) => {
        const errorMsg = String(err.message || err);
        const isExpectedError = isExpectedTransientError(errorMsg);
        if (!isExpectedError) routerLog(`[router] Skipping ${ref}: ${errorMsg}`);
        pushError(ref, errorMsg);
        ctx.recordSoftFailure(ref);
        pushRouterInfoLogged(proxy, `> [router] Trying next model (${ref} unavailable: ${errorMsg})\n\n`);
        return null;
      });
      if (!target) {
        const why = ctx.skipReasons.get(ref);
        if (why) pushError(ref, why);
        ctx.recordSoftFailure(ref);
        continue;
      }

      const prefix = label ? `${label} · ${ref}` : ref;
      pushRouterInfoLogged(proxy, `> [router] ${prefix}\n\n`);
      ctx.router.setCurModel(ref);
      ctx.router.setActiveGroup(ctx.activeGroup);
      ctx.curModel = ref;
      ctx.lastDynamicModel = ref;

      try {
        const result = await ctx.consumeWithDetection(
          target.stream, proxy,
          ctx.getEmptyResponseTimeout(ref),
          ctx.getStallTimeout(ref)
        );

        if (result.ok) {
          ctx.recordOk(ref);
          return;
        }
        if (result.reason === 'aborted') return;

        if (result.reason === 'rate_limit_exceeded') {
          const rlResult = ctx.recordStreamFailure(ref, String(result.reason), result.resetAtMs);
          pushError(ref, 'rate_limit_exceeded');
          const nextRef = candidates.slice(i + 1).find(r => !ctx.isLimited(r));
          const suffix = nextRef ? `, trying ${nextRef} …` : '';
          const keyMsg = rlResult.rotated ? ` (key rotated to ${rlResult.newKey})` : '';
          const resetMsg = ctx.formatResetMsg(ref, result.resetAtMs, rlResult.rotated);
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
            const tried = [...candidates.slice(0, i + 1), ...largerCandidates];
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
          ctx.recordSoftFailure(ref);
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
          ctx.recordSoftFailure(ref);
          const nextRef = candidates.slice(i + 1).find(r => !ctx.isLimited(r));
          const suffix = nextRef ? `, trying ${nextRef} …` : '';
          pushRouterInfoLogged(
            proxy,
            `> [router] ${ref} — stuck in a repetition loop (${result.detail ?? 'loop detected'})${suffix}\n\n`
          );
          continue;
        }
        if (isPaidCloudRateLimitFailure(ref, String(result.reason))) {
          const rlResult = ctx.recordStreamFailure(ref, String(result.reason), result.resetAtMs);
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
        // Soft failure
        pushError(ref, String(result.reason));
        ctx.recordSoftFailure(ref);
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
        ctx.recordSoftFailure(ref);
        const nextRef = candidates.slice(i + 1).find(r => !ctx.isLimited(r));
        const suffix = nextRef ? `, trying ${nextRef} …` : '';
        pushRouterInfoLogged(proxy, `> [router] ${ref} — error: ${errorMsg}${suffix}\n\n`);
      } finally {
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

    // Total cooldown collapse
    if (allFailed && cooldownSkips > 0 && cooldownSkips === allErrors.length) {
      let bestRef: string | null = null;
      let bestSecs = Number.POSITIVE_INFINITY;
      for (const ref of candidates) {
        const secs = ctx.router.limitSecs(ref);
        if (secs < bestSecs) { bestSecs = secs; bestRef = ref; }
      }
      if (bestRef) {
        routerLog(
          `[router] Total cooldown collapse — all ${candidates.length} candidate(s) in cooldown. Force-retrying ${bestRef} (${bestSecs}s remaining).`
        );
        pushRouterInfo(proxy, `> [router] All models in cooldown, retrying ${bestRef} (shortest cooldown, ${bestSecs}s)...\n\n`);
        ctx.router.setCurModel(bestRef);
        ctx.router.setActiveGroup(ctx.activeGroup);
        ctx.curModel = bestRef;
        ctx.lastDynamicModel = bestRef;
        const target = await ctx.tryStream(bestRef, context, options).catch((err) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          pushError(bestRef!, errorMsg);
          ctx.recordSoftFailure(bestRef!);
          return null;
        });
        if (target) {
          try {
            const result = await ctx.consumeWithDetection(
              target.stream, proxy,
              ctx.getEmptyResponseTimeout(bestRef),
              ctx.getStallTimeout(bestRef)
            );
            if (result.ok) {
              ctx.recordOk(bestRef);
              return;
            }
            if (result.reason === 'aborted') return;
            pushError(bestRef, String(result.reason));
            if (result.reason === 'context_overflow') {
              ctx.recordSoftFailure(bestRef);
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
            if (result.reason === 'repetition_loop') {
              ctx.recordSoftFailure(bestRef);
              pushRouterInfoLogged(
                proxy,
                `> [router] ${bestRef} — stuck in a repetition loop (${result.detail ?? 'loop detected'})\n\n`
              );
            } else {
              const frResult = ctx.recordStreamFailure(bestRef, String(result.reason), result.resetAtMs);
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
            ctx.recordSoftFailure(bestRef);
          } finally {
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
    try {
      const userMsgs = context.messages.filter((m: any) => m.role === 'user');
      const prev = userMsgs[userMsgs.length - 2];
      if (!prev) return undefined;
      const c = prev.content;
      if (typeof c === 'string') return c.slice(0, 150);
      if (Array.isArray(c)) {
        const textContent = (c as any[])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text as string)
          .join('');
        return textContent.slice(0, 150);
      }
    } catch { /* context shape unknown */ }
    return undefined;
  }
}
