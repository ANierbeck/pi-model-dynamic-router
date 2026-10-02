/**
 * The /router slash command, extracted from index.ts (refactor plan
 * 2026-10-02, task 11). Output strings were byte-identical at extraction
 * time (plan invariant, guarded by cost-report/version/package-contents
 * tests). One deliberate post-extraction change (owner request 2026-10-02):
 * the dynamic group's classifier block no longer hardcodes "via Ollama
 * (gemma2:2b)" — it shows the backend that last classified plus the live
 * chain state (formatClassifierStatus). Deviation from
 * the plan, deliberately: the handler's subcommand if-chain moves as ONE
 * unit (pure code motion) instead of one-function-per-subcommand — the
 * split would be a behavior-risk restructuring for no functional gain and
 * can follow later if wanted. Pure code motion.
 */

import { costTracker } from './cost-tracker.ts';
import { getLastClassificationSource, type ClassificationSourceInfo } from './content-classifier.ts';
import { getCachedFallbackModels } from './classifier-fallback-probe.ts';
import { isOllamaAvailable } from './ollama-utils.ts';
import { routerLog } from './logger.ts';
import * as metricsModule from './metrics.ts';
import { clearBlocklist, activeBlocks } from './model-blocklist.ts';
import { isProviderWedged, wedgeFixHint } from './provider-watchdog.ts';
import { formatErrorsReport } from './session-errors.ts';
import { fmt, splitRef } from './utils.ts';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import type { Cache, Config, Group, Metrics } from './types.ts';
import type { CacheManager } from './cache.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { RateLimitManager } from './rate-limit.ts';
import type { Router } from './routing.ts';

/**
 * Dependencies createCommands reads from index.ts's extension closure. Exposed as
 * live accessors (getters, plus setters for state the moved code writes), so
 * every read sees the CURRENT closure value — index.ts reassigns cfg/router/
 * managers on reload, and a captured copy would go stale.
 */
interface CommandDeps {
  readonly allDiscoveredRefs: () => string[];
  readonly cache: Cache;
  readonly cacheManager: CacheManager;
  readonly cfg: Config;
  readonly costMux: (prov: string) => number;
  readonly curModel: string;
  readonly effCost: (ref: string) => number | "unknown";
  readonly fmtModel: (ref: string, i: number, sel: boolean) => string;
  readonly formatBlocklist: () => string;
  readonly getM: (ref: string) => Metrics;
  readonly getTopModels: (groupName: string, n: number) => { models: { ref: string; limited: boolean; rank: number; }[]; total: number; };
  readonly getUsage: (ref: string, days: number) => number;
  readonly isLimited: (ref: string) => boolean;
  readonly limitSecs: (ref: string) => number;
  readonly load: () => void;
  readonly lookupPrice: (ref: string) => { input: number | "unknown"; output: number | "unknown"; } | null;
  readonly pi: ExtensionAPI;
  readonly rateLimitManager: RateLimitManager;
  readonly resolve: (name: string) => { selected: string; candidates: string[]; } | null;
  readonly router: Router;
  readonly scan: (force?: boolean) => Promise<void>;
  sessionCtx: any;
  readonly sessionStart: number;
}

/** Input for {@link formatClassifierStatus} — gathered live by the /router status handler. */
export interface ClassifierStatusInput {
  group: Group;
  last: ClassificationSourceInfo | null;
  probedCount: number;
  ollamaUp: boolean;
}

/**
 * Honest classifier status lines for the dynamic group's /router block:
 * which backend produced the last classification, and the chain as it is
 * actually executed (cloud-first per the 2026-09-27 design, local Ollama as
 * a last resort, static as the final fallback). Pure — all inputs are
 * gathered by the caller so this stays trivially testable.
 */
export function formatClassifierStatus(input: ClassifierStatusInput): string[] {
  const { group: g, last, probedCount, ollamaUp } = input;
  const lines: string[] = [];
  lines.push(`│ Classifier: ${last ? `${last.source} (last used)` : 'none yet this session'}`);
  const legs: string[] = [];
  if (g.classifier_cloud_fallback) {
    legs.push(
      g.classifier_cloud_model
        ? `cloud (pinned ${g.classifier_cloud_model} + ${probedCount} probed)`
        : `cloud (${probedCount} probed)`
    );
  }
  const local = (ref: string | undefined, dflt: string) => (ref ?? dflt).replace(/^ollama\//, '');
  legs.push(
    `Ollama (${ollamaUp ? 'up' : 'down'}: ${local(g.classifier_model, 'ollama/mistral-nemo:latest')} → ${local(g.classifier_fallback, 'ollama/gemma2:2b')})`
  );
  legs.push('static');
  lines.push(`│ Chain: ${legs.join(' → ')}`);
  return lines;
}

export function createCommands(rt: CommandDeps) {
  // ── Command: /router ───────────────────────────────────────────────────

  rt.pi.registerCommand('router', {
    description:
      'Model router status. Usage: /router [group|scan|cost|errors [n]|blocklist [clear [ref]]|cooldowns [clear]]',
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      // Sub-command + group name completion (TAB-friendly).
      const subcommands: AutocompleteItem[] = [
        { value: 'scan', label: 'scan', description: 'Re-discover models, re-scrape GDPval, regenerate config' },
        { value: 'cost', label: 'cost', description: 'Cost report: ALL session models (Req/In/Out/Marginal/Tier) + 1d/7d/30d token windows with ≈ blended-price estimate' },
        { value: 'errors', label: 'errors', description: 'Main-session stream failures — headline count matches the status-line ⚠N err exactly' },
        { value: 'errors 30', label: 'errors <n>', description: 'Show up to <n> entries (default 15, max 50)' },
        { value: 'blocklist', label: 'blocklist', description: 'Show models blocked after permanent provider failures' },
        { value: 'blocklist clear', label: 'blocklist clear', description: 'Unblock all models, or one: blocklist clear <provider/model>' },
        { value: 'cooldowns', label: 'cooldowns', description: 'Show active rate-limit cooldowns (ref, remaining, hits)' },
        { value: 'cooldowns clear', label: 'cooldowns clear', description: 'Clear all cooldowns + model-health streaks (incident relief, no restart needed)' },
      ];
      const groupNames: AutocompleteItem[] = Object.keys(rt.cfg.model_groups ?? {}).map((g) => {
        const desc = rt.cfg.model_groups?.[g]?.description;
        return desc
          ? { value: g, label: g, description: desc }
          : { value: g, label: g };
      });
      const all = [...subcommands, ...groupNames];
      const prefix = argumentPrefix.toLowerCase();
      const filtered = prefix
        ? all.filter((a) => a.value.toLowerCase().startsWith(prefix))
        : all;
      return filtered.length ? filtered : null;
    },
    handler: async (args, ctx) => {
      rt.load();
      const arg = args?.trim();
      
      // Temporarily set session context so allDiscoveredRefs() can access modelRegistry
      // This allows /router command to show models from Pi's registry even outside a session
      const previousSessionCtx = rt.sessionCtx;
      
      try {
        if (ctx.modelRegistry) {
          rt.sessionCtx = ctx;
          rt.router.setSessionCtx(ctx);
        }
        
        if (arg === 'scan') {
          ctx.ui.notify('Scanning...');
          await rt.scan(true);
          ctx.ui.notify(
            `Done. ${Object.keys(metricsModule.getGdpval()).length} scores, ${rt.cache.available_models?.length ?? 0} models.`
          );
          return;
        }

        if (arg === 'cost') {
          // On-demand snapshot via ctx.ui.notify — same channel as the rest of
          // /router's output. Previously cost-tracker.ts printed unconditional
          // console.log/warn on every request and on the daily/exit summary,
          // which bypasses ctx.ui.notify entirely and corrupts the TUI's input
          // prompt rendering. That automatic output is now opt-in only (via
          // DEBUG_COST_TRACKER=true); this command is the supported way to see
          // costs on demand, and formatCostReport() does NOT reset metrics, so
          // repeated calls keep showing the same accumulating totals.
          //
          // Audit depth (owner decision 2026-09-27 "volle Audittiefe"): ALL
          // session models with Req/In/Out/Marginal/Tier (subscription marked
          // sunk — virtual prices, not real spend) + persistent token windows
          // 1d/7d/30d from usage_log with a blended-price estimate (≈ —
          // usage_log has only total tokens per request; honest labeling).
          ctx.ui.notify(
            costTracker.formatCostReport({
              billingTier: (ref) => metricsModule.billingTier(ref),
              // One pass per window over usage_log (getUsageAll), keyed by the
              // refs that actually have usage — the report shows windows even
              // right after a restart when the session table is empty (I1).
              windowsAll: () => {
                const d1 = metricsModule.getUsageAll(1);
                const d7 = metricsModule.getUsageAll(7);
                const d30 = metricsModule.getUsageAll(30);
                const out: Record<string, { d1: number; d7: number; d30: number }> = {};
                for (const ref of new Set([...Object.keys(d1), ...Object.keys(d7), ...Object.keys(d30)])) {
                  out[ref] = { d1: d1[ref] ?? 0, d7: d7[ref] ?? 0, d30: d30[ref] ?? 0 };
                }
                return out;
              },
              price: (ref) => {
                const p = rt.lookupPrice(ref);
                return p && typeof p.input === 'number' && typeof p.output === 'number'
                  ? { input: p.input, output: p.output }
                  : undefined;
              },
            }),
            'info'
          );
          return;
        }

        if (arg === 'errors' || arg?.startsWith('errors ')) {
          // Counterpart of the status-line ⚠N err (single source of truth:
          // the cache.session_errors ring buffer pushed by
          // recordStreamFailure). Headline count == status-line count by
          // construction; entries from earlier processes appear below the
          // divider (diagnosis context without breaking correlation).
          const m = arg?.match(/^errors\s+(\d+)$/);
          const limit = m ? Math.max(1, Math.min(50, parseInt(m[1], 10))) : 15;
          ctx.ui.notify(formatErrorsReport(rt.cache, rt.sessionStart, limit), 'info');
          return;
        }

        if (arg === 'blocklist') {
          ctx.ui.notify(rt.formatBlocklist(), 'info');
          return;
        }
        if (arg?.startsWith('blocklist clear')) {
          const target = arg.slice('blocklist clear'.length).trim() || undefined;
          const removed = clearBlocklist(rt.cache, target);
          rt.cacheManager.saveCache(rt.cache);
          routerLog(`[router] blocklist cleared manually (${target ?? 'all'}): ${removed} block(s) removed`);
          ctx.ui.notify(
            target
              ? removed ? `Unblocked ${target}.` : `${target} was not blocked.`
              : `Blocklist cleared (${removed} model(s)).`,
            'info'
          );
          return;
        }

        if (arg === 'cooldowns') {
          const active = rt.rateLimitManager.listLimits();
          const health = rt.cache.model_health ?? {};
          const healthEntries = Object.entries(health)
            .filter(([, v]) => v && typeof v.fails === 'number' && v.fails > 0)
            .sort((a, b) => b[1].fails - a[1].fails);
          const lines: string[] = ['Active cooldowns (shortest first):'];
          if (active.length === 0) {
            lines.push('  (none — no model is in cooldown)');
          } else {
            for (const c of active) {
              const reset = c.resetAtMs
                ? ` (provider reset ${new Date(c.resetAtMs).toLocaleTimeString()})`
                : '';
              lines.push(`  • ${c.ref}: ${c.secs}s remaining, ${c.hits} hit(s)${reset}`);
            }
          }
          lines.push('', 'Model-health failure streaks (demotion):');
          if (healthEntries.length === 0) {
            lines.push('  (none — all models healthy)');
          } else {
            for (const [ref, h] of healthEntries) {
              lines.push(`  • ${ref}: ${h.fails} recent fail(s)`);
            }
          }
          ctx.ui.notify(lines.join('\n'), 'info');
          return;
        }
        if (arg?.startsWith('cooldowns clear')) {
          const cleared = rt.rateLimitManager.clearAllLimits();
          const health = rt.cache.model_health;
          let healthCleared = 0;
          if (health) {
            healthCleared = Object.keys(health).length;
            rt.cache.model_health = {};
            rt.cacheManager.saveCache(rt.cache);
          }
          routerLog(
            `[router] cooldowns cleared manually: ${cleared} cooldown(s) + ${healthCleared} model-health streak(s)`
          );
          ctx.ui.notify(
            `Cooldowns cleared (${cleared} cooldown(s), ${healthCleared} health streak(s)). All models are immediately available for routing again.`,
            'info'
          );
          return;
        }

        if (arg && rt.cfg.model_groups[arg]) {
          const g = rt.cfg.model_groups[arg],
            res = rt.resolve(arg);
          const desc =
            g.method === 'pipeline'
              ? `pipeline(${g.pipeline!.map((s) => `${s.method}:${s.top_k ?? '∞'}`).join('→')})`
              : g.method;
          const lines = [`${arg} | ${desc}`, g.description ?? '', ''];
          if (res) res.candidates.forEach((r, i) => lines.push(rt.fmtModel(r, i, i === 0)));
          else lines.push('(no available models)');
          ctx.ui.notify(lines.filter(Boolean).join('\n'), 'info');
          return;
        }

      // Overview with table
      const lines: string[] = ['Model Router', ''];

      // Group tables with top 5 models (3 available + up to 2 limited)
      for (const [groupName, g] of Object.entries(rt.cfg.model_groups)) {
        const n = 5;
        const { models: topModels, total } = rt.getTopModels(groupName, n);
        const method =
          g.method === 'pipeline'
            ? g.pipeline!.map((s) => `${s.method}${s.top_k ? `:${s.top_k}` : ''}`).join(' → ')
            : g.method === 'best'
              ? 'best gdpval'
              : g.method === 'tiered'
                ? g.min_gdpval != null
                  ? `tiered ≥${g.min_gdpval}`
                  : `tiered ≥${g.min_gdpval_pct ?? 0}%`
                : g.method === 'dynamic'
                  ? 'dynamic (content-based)'
                  : g.method;
        const active = rt.curModel && rt.allDiscoveredRefs().includes(rt.curModel);
        const activeMarker = active ? ' ◀' : '';


        // Add fallback groups info if present
        const fallbackInfo = g.fallback_groups && g.fallback_groups.length > 0 
          ? ` (\u2192 ${g.fallback_groups.join(' \u2192 ')})`
          : '';

        // Group header
        lines.push(`┌─ ${groupName}${activeMarker} `.padEnd(72, '─') + ` ${method}${fallbackInfo} ─`);

        if (topModels.length === 0 && g.method === 'dynamic') {
          const cats = [
            'code_simple→operational',
            'code_complex→tactical',
            'design→strategic',
            'planning→tactical',
            'exploration→scout',
          ];
          lines.push('│ Routes per prompt via content classification:');
          cats.forEach((c) => lines.push(`│   ${c}`));
          // Honest classifier state (2026-10-02 owner finding): the old block
          // hardcoded "via Ollama (gemma2:2b)" while the cloud fallback chain
          // was doing the actual work whenever Ollama is down. Show the backend
          // that last classified plus the live chain state instead.
          lines.push(
            ...formatClassifierStatus({
              group: g,
              last: getLastClassificationSource(),
              probedCount: getCachedFallbackModels(rt.cache).length,
              ollamaUp: await isOllamaAvailable(),
            })
          );
        } else if (topModels.length === 0) {
          lines.push('│ (no models configured)');
        } else {
          // Compute max model name width (capped at 38)
          const MW = Math.min(38, Math.max(5, ...topModels.map((t) => t.ref.length)));

          // Table header
          lines.push(
            `│ ${'#'.padEnd(3)} ${'Model'.padEnd(MW)}  ${'GDP'.padStart(4)}  ${'Lat'.padStart(5)}  ${'TPS'.padStart(4)}  ${'Cost I/O'.padStart(11)}  ${'Usage 1d/7d/30d'.padStart(15)}  ${'Budg'.padStart(6)}  Status`
          );
          lines.push(
            `│ ${'─'.padEnd(3)} ${'─'.repeat(MW)}  ${'────'}  ${'─────'}  ${'────'}  ${'───────────'}  ${'───────────────'}  ${'──────'}  ──────`
          );

          for (const { ref, limited, rank } of topModels) {
            const m = rt.getM(ref);
            const prov = ref.split('/')[0];
            const mux = rt.costMux(prov);
            const cost = rt.effCost(ref);
            const price = rt.lookupPrice(ref);
            const modelShort = ref.length > MW ? '…' + ref.slice(-(MW - 1)) : ref;
            const isActive = rt.curModel === ref;
            const statusParts: string[] = [];
            if (limited) statusParts.push(`⛔${rt.limitSecs(ref)}s`);
            if (mux > 1) statusParts.push(`×${mux}`);
            if (isActive) statusParts.push('●');
            const status = statusParts.join(' ') || (limited ? '' : 'active');

            const costDisplay = price && price.input !== 'unknown' && price.output !== 'unknown'
              ? `$${typeof price.input === 'number' ? price.input.toFixed(1) : '?'}/$${typeof price.output === 'number' ? price.output.toFixed(1) : '?'}`
              : cost !== 'unknown' && typeof cost === 'number'
                ? `$${cost.toFixed(1)}`
                : 'unknown';

            // Add budget info for subscription providers
            const budgetInfo = rt.cache.budget_cache?.[prov];
            let budgetDisplay = '';
            if (budgetInfo && budgetInfo.window_reset && budgetInfo.remaining_tokens !== undefined) {
              const now = Date.now();
              if (now < budgetInfo.window_reset) {
                const remaining = budgetInfo.remaining_tokens;
                const windowType = budgetInfo.window_type ?? 'monthly';
                budgetDisplay = `${Math.round(remaining)}${windowType.substring(0, 1)}`;
              }
            }

            const u1 = rt.getUsage(ref, 1),
              u7 = rt.getUsage(ref, 7),
              u30 = rt.getUsage(ref, 30);
            const usageDisplay = `${fmt(u1)}/${fmt(u7)}/${fmt(u30)}`;

            const sel = rank === 0 ? ' ←' : '';
            lines.push(
              `│ ${String(rank + 1).padEnd(3)} ${modelShort.padEnd(MW)}  ${String(m.gdpval).padStart(4)}  ${String(Math.round(m.avg_latency_ms)).padStart(5)}  ${String(Math.round(m.throughput_tps)).padStart(4)}  ${costDisplay.padStart(11)}  ${usageDisplay.padStart(15)}  ${budgetDisplay.padStart(6)} ${status}${sel}`
            );
          }
        }
        // Footer: show total count if more than shown
        if (total > n) {
          lines.push(`│    … +${total - n} weitere (sortiert nach ${g.method})`);
        }
        lines.push('│');
      }

      // Rate-limited summary
      const rl = [...rt.rateLimitManager.getLimits().keys()].filter((r) => rt.isLimited(r));
      if (rl.length) {
        lines.push('├─ Rate Limited '.padEnd(72, '─'));
        for (const r of rl) {
          const { provider, modelId } = splitRef(r);
          lines.push(`│ ⛔ ${provider}/${modelId} (${rt.limitSecs(r)}s remaining)`);
        }
      }

      // Refused automatic scan (scan sanity check 3)
      const refusal = rt.cache.scan_sanity_refusal;
      if (refusal) {
        lines.push('├─ Scan '.padEnd(72, '─'));
        lines.push(
          `│ ⚠ last automatic scan refused: ${refusal.survivors} models vs ${refusal.previous} before. ` +
            'Accepted if a settled scan agrees; /router scan accepts it now.'
        );
      }

      // Local-provider watchdog (ADR-0016)
      for (const [provider, h] of Object.entries(rt.cache.local_provider_health ?? {})) {
        if (!isProviderWedged(rt.cache, provider)) continue;
        const secs = Math.ceil(((h.wedged_until ?? 0) - Date.now()) / 1000);
        lines.push('├─ Local provider watchdog '.padEnd(72, '─'));
        lines.push(`│ ⚠ ${provider} looks wedged — skipped for ${secs}s. Fix: ${wedgeFixHint(provider)}.`);
      }

      // Learned blocklist summary (details: /router blocklist)
      const blocked = activeBlocks(rt.cache);
      if (blocked.length) {
        lines.push('├─ Blocked (permanent provider failures) '.padEnd(72, '─'));
        lines.push(`│ 🚫 ${blocked.length} model(s) — see /router blocklist`);
      }

      lines.push('└' + '─'.repeat(71));
      lines.push('', '/router <group> | scan | cost | blocklist');
      ctx.ui.notify(lines.join('\n'), 'info');
      } finally {
        // Always restore previous session context
        rt.sessionCtx = previousSessionCtx;
        rt.router.setSessionCtx(previousSessionCtx);
      }
    },
  });
}
