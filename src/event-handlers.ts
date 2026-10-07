/**
 * Core pi event handlers, extracted from index.ts (refactor plan
 * 2026-10-02, task 9): session_start (load, scan kick-off, group model
 * registration), model_select, turn_start, turn_end (cost/footer updates,
 * every-10-turns saveCache), tool_call (expensive-model read block),
 * tool_result (rate-limit detection), and the session_shutdown that saves
 * the cache. Registration happens at factory time, preserving the handlers'
 * relative order; the LAST session_shutdown (session anchor reset) and the
 * process-exit/signal cleanup deliberately stay at the bottom of index.ts.
 * Pure code motion.
 */

import { resolveReadBlockStreamRef, checkReadBlock } from './bulk-read.ts';
import { costTracker } from './cost-tracker.ts';
import { handleReadDelegation } from './delegation.ts';
import { setProjectLogDir, debugLog, routerLog, warnLog } from './logger.ts';
import * as metricsModule from './metrics.ts';
import { setPiRegisteredProviders, setModelRegistry } from './metrics.ts';
import { countSessionErrorsSince } from './session-errors.ts';
import { fmt, fmtTime } from './utils.ts';
import { buildUsageLogEntry, formatCacheStatus } from './cache-stats.ts';
import { runContextCompaction, type CompactionRunState } from './context-compaction.ts';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { fileURLToPath } from 'node:url';
import type { Cache, Config, Metrics } from './types.ts';
import type { SessionEscalation } from './escalation.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { RateLimitManager } from './rate-limit.ts';
import type { Router } from './routing.ts';

/**
 * Dependencies createEventHandlers reads from index.ts's extension closure. Exposed as
 * live accessors (getters, plus setters for state the moved code writes), so
 * every read sees the CURRENT closure value — index.ts reassigns cfg/router/
 * managers on reload, and a captured copy would go stale.
 */
interface EventHandlerDeps {
  activeGroup: string | null;
  readonly cache: Cache;
  readonly cfg: Config;
  curModel: string;
  readonly detectGroup: (ref: string) => string | null;
  readonly escalation: SessionEscalation;
  readonly extDir: string;
  readonly getM: (ref: string) => Metrics;
  readonly isLimited: (ref: string) => boolean;
  readonly lastDynamicModel: string;
  readonly load: () => void;
  readonly loadCache: () => void;
  readonly pi: ExtensionAPI;
  readonly rateLimitManager: RateLimitManager;
  readonly recordOk: (ref: string) => void;
  readonly registerGroupModels: (ctx: any) => Promise<void>;
  readonly router: Router;
  readonly saveCache: () => void;
  readonly scan: (force?: boolean) => Promise<void>;
  sessionAnchorInit: boolean;
  sessionCtx: any;
  sessionStart: number;
  statusUpdater: ((key: string, text: string) => void) | null;
  turnStart: number;
  readonly updateErrorStatusLine: () => void;
  readonly updateMetrics: (ref: string, latMs: number, tokens: number, durMs: number) => void;
}

export function createEventHandlers(rt: EventHandlerDeps) {

  rt.pi.on('session_start', async (ev, ctx) => {
    rt.sessionCtx = ctx;
    rt.router.setSessionCtx(ctx);
    setProjectLogDir(ctx.cwd);
    try {
      const piAiPath = fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'));
      const providerIds = (ctx.modelRegistry as any).getRegisteredProviderIds?.() ?? [];
      debugLog(`[diag] pi-ai resolved from: ${piAiPath}`);
      debugLog(`[diag] registered providers visible to router: ${[...providerIds].join(', ') || '(none)'}`);
      // F11 (2026-09-02): publish pi's registered provider IDs to the metrics
      // module so stripProvider() recognizes pi-managed providers (pi-claude,
      // claude-bridge, extension providers) the router has no static
      // PROVIDER_MAP entry for. Without this, stripProvider leaves the full
      // 'pi-claude/claude-sonnet-5' ref intact and GDPval/price inference
      // never resolves the model id.
      setPiRegisteredProviders(providerIds);
      // Publish pi's modelRegistry so `lookupPrice()`/`getM()` can read the
      // real `Model.cost` for any pi-registered provider. `Model.cost` is a
      // required field populated from the provider's own /v1/models (e.g.
      // requesty reports `input_price`/`output_price`), so the registry is
      // the authoritative price source — more reliable than the router's own
      // fallbacks (cfg.model_metrics / openrouter_pricing / OR-backfill /
      // cfg.providers), which all silently miss providers Pi registered
      // through other channels (extensions, models.json, CLI flags).
      // Uses the same public `ctx.modelRegistry` API the router already uses
      // for `getAvailable()`/`find()` elsewhere — never reads Pi's setup
      // files directly.
      setModelRegistry((ctx as any).modelRegistry);
    } catch (e) {
      debugLog('[diag] version diagnostics failed:', e);
    }
    rt.load();
    metricsModule.loadModelMap(rt.extDir);
    rt.loadCache();
    // Correlation anchor (review M2): reset ONLY on real user session switches
    // (/new, /resume, /fork) and the FIRST session_start of the process (boot).
    // In-process subagent sessions re-fire session_start with reason 'startup'
    // (pi-subagents child-session.js:287) — resetting there would silently
    // drop the main session's errors from the status count. 'reload' keeps the
    // anchor: the session continues, its errors stay counted.
    const startReason = (ev as any)?.reason;
    if (!rt.sessionAnchorInit || startReason === 'new' || startReason === 'resume' || startReason === 'fork') {
      rt.sessionStart = Date.now();
      rt.sessionAnchorInit = true;
    }
    // Capture pi's setStatus ONLY from a ctx that has it — the MAIN session's
    // interactive TUI. A subagent's headless ctx has no setStatus; overwriting
    // the captured updater there would stall the main session's immediate
    // footer refresh. The count itself is rendered by our own footer part
    // (see setFooter below — our footer REPLACES pi's built-in footer, which is
    // the only renderer of extension statuses, review C1), so setStatus is
    // only the immediate-re-render trigger, not the display path. index.ts is
    // not duplicated by the esbuild double-bundle hazard; the BUFFER state
    // stays in the cache object per project rule.
    if (typeof (ctx.ui as any).setStatus === 'function') {
      rt.statusUpdater = (key: string, text: string) => {
        (ctx.ui as any).setStatus(key, text);
      };
    }
    rt.updateErrorStatusLine();
    
    rt.escalation.reset();
    
    await rt.registerGroupModels(ctx);
    // scan() swallows per-provider failures by design, but a top-level
    // throw (e.g. from checkScanSanity or saveCache) must not disappear
    // silently (final v1.6.0 review minor #6).
    rt.scan().catch((err) =>
      warnLog(`[scan] background scan failed: ${err instanceof Error ? err.message : String(err)}`)
    );

    // Footer
    ctx.ui.setFooter((tui, theme, fd) => {
      const unsub = fd.onBranchChange(() => tui.requestRender());
      const timer = setInterval(() => tui.requestRender(), 30000);
      return {
        dispose() {
          unsub();
          clearInterval(timer);
        },
        invalidate() {},
        render(w: number): string[] {
          const ref = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '';
          // The router never swaps the session's active model (see driveStream) —
          // ctx.model stays the virtual group model (e.g. "standard/standard") for
          // the whole session. Detect that here so the footer can show the actually
          // resolved model (lastDynamicModel, updated by driveStream on every
          // successful stream) instead of the static virtual model id.
          const groupBase = ctx.model?.id?.replace(/:use-static$/, '');
          const isGroupModel = groupBase ? Object.prototype.hasOwnProperty.call(rt.cfg.model_groups, groupBase) : false;
          const grp = isGroupModel ? groupBase! : ref ? rt.detectGroup(ref) : null;
          const m = ref ? rt.getM(isGroupModel && rt.lastDynamicModel ? rt.lastDynamicModel : ref) : null;
          const modelDisplay =
            isGroupModel && rt.lastDynamicModel
              ? rt.lastDynamicModel
              : `${ctx.model?.provider ?? '?'}/${ctx.model?.id ?? '?'}`;
          const rStr = theme.fg('accent', `${grp ?? '—'}/${modelDisplay}`);
          const iStr = m ? theme.fg('warning', `int:${m.gdpval}`) : '';
          const tStr = m ? theme.fg('success', `tps:${Math.round(m.throughput_tps)}`) : '';

          let inp = 0,
            out = 0,
            cost = 0,
            steps = 0;
          let lastUsage: AssistantMessage['usage'] | undefined;
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === 'message' && e.message.role === 'assistant') {
              const a = e.message as AssistantMessage;
              inp += a.usage.input;
              out += a.usage.output;
              cost += a.usage.cost.total;
              steps++;
              lastUsage = a.usage;
            }
          }
          // Phase 5a: context size, cache share of the last step and the
          // session-average cost per step ("ctx 182.0k · cache 97% · ~$0.03/step").
          const cacheStr = formatCacheStatus(lastUsage, steps, cost);
          const u = ctx.getContextUsage(),
            pct = u?.percent ?? 0;
          const pCol = pct > 75 ? 'error' : pct > 50 ? 'warning' : 'success';
          const tok = [
            theme.fg('accent', `${fmt(inp)}/${fmt(out)}`),
            theme.fg('warning', `$${cost.toFixed(2)}`),
            theme.fg(pCol, `${pct.toFixed(0)}%`),
          ].join(' ');
          const el = theme.fg('dim', `⏱${fmtTime(Date.now() - rt.sessionStart)}`);
          const pp = process.cwd().split('/');
          const cwd = theme.fg(
            'muted',
            `⌂ ${pp.length > 2 ? pp.slice(-2).join('/') : process.cwd()}`
          );
          const br = fd.getGitBranch();
          const brS = br ? theme.fg('accent', `⎇ ${br}`) : '';
          const rlN = [...rt.rateLimitManager.getLimits().keys()].filter((r) => rt.isLimited(r)).length;
          const rlS = rlN > 0 ? theme.fg('error', `⛔${rlN}`) : '';
          // Session error counter (review C1): this footer REPLACES pi's
          // built-in footer — the only renderer of ctx.ui.setStatus extension
          // statuses — so the counter MUST be a part here. Same single source
          // of truth as /router errors: entries with ts >= sessionStart.
          const errN = countSessionErrorsSince(rt.cache, rt.sessionStart, process.pid);
          const errS = errN > 0 ? theme.fg('error', `⚠${errN} err`) : '';

          const sep = theme.fg('dim', ' | ');
          const parts = [rStr];
          if (iStr && tStr) parts.push(`${iStr} ${tStr}`);
          parts.push(tok);
          if (cacheStr) parts.push(theme.fg('dim', cacheStr));
          parts.push(el, cwd);
          if (brS) parts.push(brS);
          if (rlS) parts.push(rlS);
          if (errS) parts.push(errS);
          return [truncateToWidth(parts.join(sep), w)];
        },
      };
    });
  });


  rt.pi.on('model_select', async (ev) => {
    if (ev.source !== 'restore') rt.activeGroup = null;
    rt.curModel = `${ev.model.provider}/${ev.model.id}`;
  });
  // Hint cooldown state for cache-aware compaction (Phase 5b): without it,
  // a long over-soft session with a cold cache would notify on EVERY turn
  // boundary. Owned here because it must survive the Router reloads.
  const compactionState: CompactionRunState = { lastHintAt: 0 };

  rt.pi.on('turn_start', async (_ev, ctx) => {
    rt.turnStart = Date.now();
    // Mark the turn boundary on the router so the first setCurModel() of
    // this turn re-pins the driving ref (a nested delegation stream must
    // not be able to overwrite the pin — see Router.noteTurnStart).
    rt.router.noteTurnStart(rt.turnStart);
    if (ctx.model) rt.curModel = `${ctx.model.provider}/${ctx.model.id}`;
    // Cache-aware compaction (Phase 5b): evaluated ONLY here — at the turn
    // boundary, before the prompt is processed, never between tool steps
    // (owner decision 2026-10-05). Fire-and-forget inside.
    runContextCompaction({
      ctx: ctx as any,
      cfg: rt.cfg,
      activeGroup: rt.activeGroup,
      usageLog: rt.cache.usage_log,
      state: compactionState,
    });
  });

  rt.pi.on('turn_end', async (ev) => {
    if (!rt.curModel || !rt.turnStart) return;
    const ms = Date.now() - rt.turnStart,
      msg = ev.message;
    
    // ── Session Escalation Logic ────────────────────────────────────────
    if (msg?.role === 'user' || msg?.role === 'assistant') {
      const content = typeof msg.content === 'string'
        ? msg.content
        : (msg.content ?? [])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('');
      rt.escalation.recordTurn(
        msg.role === 'user' ? content : '',
        msg.role === 'assistant' ? content : ''
      );
    }
    
    // ── Metrics & Usage Logging ─────────────────────────────────────────
    if (msg?.role === 'assistant') {
      // Factual stream ref of THIS turn (review I1): curModel stays the
      // virtual group ref ('standard/standard') in group sessions — keying
      // usage_log by it made the /router cost windows structurally all-zero
      // (getUsage filters by real model refs). getCurModel(turnStart) is the
      // same factual-ref source the expensive-model read block uses; falls
      // back to curModel for non-routed sessions where they coincide.
      const factualRef = rt.router.getCurModel(rt.turnStart) || rt.curModel;
      const a = msg as AssistantMessage;
      // Real usage entry (Phase 5a): tokens = input + output + cacheRead +
      // cacheWrite — input alone excluded the cached bulk of a long context
      // (~40x undercount). Null when the provider reported no usage.
      const usageEntry = buildUsageLogEntry(factualRef, a.usage, Date.now());
      const realTok = usageEntry?.tokens ?? 0;
      const txt =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content ?? [])
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('');
      // usage_log basis (review I1): REAL tokens when the provider reported
      // usage (the old text.length/4 was an output-only approximation that
      // understated the blended-price estimate badly); text/4 remains a
      // last-resort fallback for usage-less messages.
      const tok = realTok > 0 ? realTok : Math.ceil(txt.length / 4);
      if (tok > 0) {
        // Throughput basis: tokens the model PRODUCED/consumed fresh. Cache
        // reads are served from the provider cache, not generated — feeding
        // them in would inflate tps (and cache.benchmarks) ~40x.
        const tpsTok = a.usage ? Math.max(0, (a.usage.input || 0) + (a.usage.output || 0)) : 0;
        rt.updateMetrics(factualRef, ms, tpsTok > 0 ? tpsTok : tok, ms);
        rt.recordOk(factualRef);
        // Log usage
        if (!rt.cache.usage_log) rt.cache.usage_log = [];
        rt.cache.usage_log.push(usageEntry ?? { ref: factualRef, tokens: tok, ts: Date.now() });
        // Trim log to last 30 days
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        rt.cache.usage_log = rt.cache.usage_log.filter((e) => e.ts > cutoff);
        // Real-token cost tracking (review I2): the old selection-time calls
        // passed hardcoded 1000/500 per request — fabricated data in an audit
        // report. Track once per COMPLETED turn with measured in/out tokens;
        // turns whose provider reported no usage are not tracked at all
        // rather than fabricated.
        if (realTok > 0) {
          costTracker.trackRequest(
            factualRef,
            a.usage!.input,
            a.usage!.output,
            a.usage!.cacheRead ?? 0,
            a.usage!.cacheWrite ?? 0
          );
        }
      }
    }
  });

  // ── Pre-call read block (shunt Layer 1, ADR-0007 revision 2026-09-20) ──
  // A full-file read (no offset/limit) of a file above delegation.block_lines
  // (default 350, shunt's SHUNT_MIN_LINES) is blocked BEFORE execution and
  // redirected to bulk_read / a targeted read. Fail-open: every miss passes.
  rt.pi.on('tool_call', (ev) => {
    // Layer 1 (ADR-0007 escalation, 2026-09-26): the factual stream ref
    // (set by the stream orchestrator for THIS turn) — not the session's
    // group provider. A fixed-session model that never routed falls back
    // to the session ref (model_select/turn_start).
    //
    // resolveReadBlockStreamRef prefers the turn's PINNED driving ref over
    // the live ref: a nested bulk_reader delegation stream sets the live ref
    // to a cheap ref mid-turn, after which the live ref alone would let the
    // expensive model's own full-file reads pass the block. Both fall back to
    // the session ref; '' (nothing pinned/stale) fails open to size-only.
    const streamRef = resolveReadBlockStreamRef(rt.router, rt.turnStart, rt.curModel);
    // Live membership source (ADR-0007 live fix, 2026-09-26): cfg may be the
    // STATIC config (no materialized model_groups[].models) or a stale scan
    // snapshot — the cfg check alone never matched live and Layer 1 was a
    // no-op (exposed by the HINT group test). getTopModels is the Router's
    // live group resolution (display path, ignores allow-lists) and reflects
    // what can actually drive each expensive group. try/catch → fail-open.
    const block = checkReadBlock(ev, rt.cfg, streamRef, (group) => {
      try {
        const { models } = rt.router.getTopModels(group, 200);
        return (models ?? []).map((m) => m.ref);
      } catch {
        return [];
      }
    });
    if (block) {
      routerLog(
        (block as { expensive?: boolean }).expensive
          ? `[bulk_read] blocked a full-file read by expensive model "${streamRef}" — redirected to bulk_read/targeted read`
          : `[bulk_read] blocked a full-file read of "${(ev as any)?.input?.path}" — redirected to bulk_read/targeted read`
      );
      return block;
    }
    return undefined;
  });

  rt.pi.on('tool_result', async (ev, ctx) => {
    // ── Enforced delegation (ADR-0007, revised 2026-09-20) ──────────────
    // Shrink oversized `read` results with a cheap summarizer (routed via
    // the delegation group — default bulk_reader) BEFORE the main model
    // sees them. Strictly fail-open: undefined → original passes through.
    const replacement = await handleReadDelegation(ev, ctx, rt.cfg, routerLog);
    if (replacement) return replacement;

    // The rate-limit branch that lived here since the initial release
    // (`txt.includes('429')` → recordLimit(curModel), later narrowed to
    // isToolResultRateLimitText) was REMOVED (roborev job 703, finding 1,
    // option a). Tool results are command output — a curl'd 429 from an
    // unrelated host, a failing vitest run printing "rate_limit_exceeded",
    // a subagent child hitting ITS five_hour limit — and none of it is
    // evidence that the CURRENT model is rate-limited, so attributing a
    // hard cooldown + key rotation to it was wrong no matter how narrow
    // the pattern table got. Genuine provider limits arrive as error
    // EVENTS ONLY (isRateLimitText in consumeWithDetection — including
    // pi-claude-bridge's "Claude rate limit …" error events); text_delta is
    // deliberately NOT scanned (d391a73: model prose is never evidence of a
    // rate limit). Pinned by test/tool-result-rate-limit.test.ts.
    // All non-delegation paths intentionally fall through with no replacement.
    return undefined;
  });

  let turns = 0;
  rt.pi.on('turn_end', async () => {
    if (++turns % 10 === 0) rt.saveCache();
  });
  rt.pi.on('session_shutdown', async () => rt.saveCache());
}
