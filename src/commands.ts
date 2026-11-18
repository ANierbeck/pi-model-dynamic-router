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

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { costTracker } from './cost-tracker.ts';
import { formatOverviewTable, displayMetricsFor, type OverviewRow } from './overview-table.ts';
import { describeBestMethod } from './rank-explain.ts';
import {
  getLastClassificationSource,
  getClassificationCounts,
  CATEGORY_TO_GROUP,
  type ClassificationSourceInfo,
  type ClassificationCounts,
} from './content-classifier.ts';
import {
  LAYA_DEFAULT_ENDPOINT,
  getLastProbeError,
  layaAvailabilityState,
  layaReportedIdentity,
  type LayaAvailabilityState,
  type LayaReportedIdentity,
} from './laya-classifier.ts';
import { formatIntegrationLines, checkIntegrationPatch } from './integration.ts';
import { INTEGRATION_SPECS } from './integration-registry.ts';
import { getCachedCloudModels } from './classifier-cloud-probe.ts';
import {
  localClassifierPins,
  resolveLocalClassifierChain,
  type LocalClassifierChain,
} from './classifier-local-probe.ts';
import { isOllamaAvailable } from './ollama-utils.ts';
import { routerLog } from './logger.ts';
import * as metricsModule from './metrics.ts';
import { clearBlocklist, activeBlocks } from './model-blocklist.ts';
import { wedgeFixHint } from './provider-watchdog.ts';
import { openBreakers, clearBreakers, isLocalProviderName } from './provider-breaker.ts';
import { formatErrorsReport } from './session-errors.ts';
import { parseSummaryDays, readClassifierSummary } from './classifier-summary.ts';
import { getLeaf, splitRef } from './utils.ts';
import { isExcluded, globMatcher } from './exclude.ts';
import { isVirtualGroupRef } from './routing.ts';
import { closestKey } from './config-schema.ts';
import {
  openUserConfigStore,
  readConfigLayers,
  validateExcludePattern,
  type ConfigLayerView,
  type ConfigPatch,
} from './user-config-store.ts';
import {
  CONFIG_KEYS,
  configKey,
  layerSetsKey,
  parseConfigValue,
  type ConfigKeySpec,
} from './config-keys.ts';
import { describeClassifierChain, formatClassifierChain } from './classifier-chain.ts';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import type { Cache, ClassifierConfig, Config, ExcludeRules, Metrics } from './types.ts';
import type { CacheManager } from './cache.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RateLimitManager } from './rate-limit.ts';
import type { Router } from './routing.ts';
import { runInSession, sessionIdOf } from './turn-state.ts';
import { hasAnyInstall } from './laya-model-install.ts';
import {
  defaultLayaInstallDeps,
  layaStatus,
  runLayaInstall,
  runLayaServe,
  runLayaStop,
  writeLayaConfigBlock,
} from './laya-install-command.ts';
import { defaultSupervisorDeps, endpointProblem } from './laya-sidecar-supervisor.ts';
import { clearCorrections, listCorrections } from './hint-corrections.ts';

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
  /** Path of the shipped router-config.json (its directory is the extension dir). */
  readonly cfgPath: string;
  readonly costMux: (prov: string) => number;
  readonly curModel: string;
  readonly effCost: (ref: string) => number | 'unknown';
  readonly fmtModel: (ref: string, i: number, sel: boolean) => string;
  readonly formatBlocklist: () => string;
  readonly getM: (ref: string) => Metrics;
  readonly getTopModels: (
    groupName: string,
    n: number
  ) => { models: { ref: string; limited: boolean; rank: number; why?: string }[]; total: number };
  readonly getUsage: (ref: string, days: number) => number;
  readonly isLimited: (ref: string) => boolean;
  readonly limitSecs: (ref: string) => number;
  readonly load: () => void;
  readonly lookupPrice: (
    ref: string
  ) => { input: number | 'unknown'; output: number | 'unknown' } | null;
  /** PAYG list price for DISPLAY — shows would-cost even when routing
   * prices the model via the subscription rule (see metrics.lookupListPrice).
   * Falls back to lookupPrice/effCost. */
  readonly lookupListPrice?: (
    ref: string
  ) => { input: number | 'unknown'; output: number | 'unknown' } | null;
  readonly pi: ExtensionAPI;
  readonly rateLimitManager: RateLimitManager;
  readonly resolve: (name: string) => { selected: string; candidates: string[] } | null;
  readonly router: Router;
  readonly scan: (force?: boolean) => Promise<void>;
  sessionCtx: ExtensionContext | null;
  readonly sessionStart: number;
}

/**
 * The "Cost I/O" column of the /router group table. Prefers the PAYG list
 * price (would-cost, like the /router cost report's Marginal column) over
 * the routing-effective price: the ADR-0025 B2 rule prices subscription
 * models at eps x list for ordering, and "$0.0/$0.0" in the table would
 * hide what the model would cost on pay-as-you-go (2026-10-04 regression:
 * opus-5-5 vs sonnet-5-5). No list price -> the old display chain
 * (effective price, then 'unknown').
 */
export function costColumnFor(
  ref: string,
  tools: Pick<CommandDeps, 'lookupListPrice' | 'lookupPrice' | 'effCost'>
): string {
  const price = tools.lookupListPrice?.(ref) ?? tools.lookupPrice(ref);
  if (price && price.input !== 'unknown' && price.output !== 'unknown') {
    return `$${typeof price.input === 'number' ? price.input.toFixed(1) : '?'}/$${typeof price.output === 'number' ? price.output.toFixed(1) : '?'}`;
  }
  const cost = tools.effCost(ref);
  return cost !== 'unknown' && typeof cost === 'number' ? `$${cost.toFixed(1)}` : 'unknown';
}

/**
 * The category→group routes listed in the dynamic group's /router block,
 * derived from the live CATEGORY_TO_GROUP (a hardcoded copy had drifted:
 * it showed design→strategic and planning→tactical after both moved to the
 * planning group).
 */
export function formatCategoryRoutes(): string[] {
  return Object.entries(CATEGORY_TO_GROUP).map(([cat, group]) => `${cat}→${group}`);
}

/** Input for {@link formatClassifierStatus} — gathered live by the /router status handler. */
export interface ClassifierStatusInput {
  /** The `classifier` config block (cloud switch and pinned cloud model shown in the chain). */
  classifier: ClassifierConfig | undefined;
  last: ClassificationSourceInfo | null;
  probedCount: number;
  ollamaUp: boolean;
  /** Derived local primary/fallback (resolveLocalClassifierChain); omitted = none yet. */
  localChain?: LocalClassifierChain;
  /** True once the scan probed the local chain; false = provisional (unprobed) heads. */
  localProbed?: boolean;
  /** Today's classification mix; omitted or empty → no counter lines. */
  counts?: ClassificationCounts;
  /** Laya stage, present when `integrations.laya.enabled` is true. */
  laya?: {
    checkpoint: string;
    endpoint: string;
    confidence_threshold: number;
    /** `active` decides; `shadow` only observes (and is therefore not part of the Chain line). */
    mode: 'active' | 'shadow';
    state: LayaAvailabilityState;
    /** Why the sidecar is down (state `down` only). */
    probeError?: string | undefined;
    /** What the sidecar reported on /health at the last probe; null/absent = nothing. */
    identity?: LayaReportedIdentity | null;
  };
}

/**
 * Honest classifier status lines for the dynamic group's /router block:
 * which backend produced the last classification, and the chain as it is
 * actually executed: Laya (when active), then the local Ollama chain, then
 * the cloud chain (local first, owner decision 2026-11-14), then static as the
 * final fallback. Pure — all inputs are gathered by the caller so this stays
 * trivially testable.
 */
export function formatClassifierStatus(input: ClassifierStatusInput): string[] {
  const { classifier, last, probedCount, ollamaUp } = input;
  const lines: string[] = [];
  lines.push(`│ Classifier: ${last ? `${last.source} (last used)` : 'none yet this session'}`);
  const legs: string[] = [];
  if (input.laya?.mode === 'active') legs.push('Laya');
  const heads = [input.localChain?.primary, input.localChain?.fallback].filter((m): m is string =>
    Boolean(m)
  );
  // Review N2, 2026-10-07: an empty head list AFTER a probe is honest about
  // the result — "none qualified" — and names the recovery paths; "none yet"
  // stays correct only while no probe ever ran.
  const localDetail =
    heads.length > 0
      ? `${heads.join(' → ')}${input.localProbed === false ? ' (unprobed)' : ''}`
      : input.localProbed
        ? 'none qualified — pin or /router scan'
        : 'none yet';
  legs.push(`Ollama (${ollamaUp ? 'up' : 'down'}: ${localDetail})`);
  if (classifier?.cloud?.enabled) {
    legs.push(
      classifier.cloud.model
        ? `cloud (pinned ${classifier.cloud.model} + ${probedCount} probed)`
        : `cloud (${probedCount} probed)`
    );
  }
  legs.push('static');
  lines.push(`│ Chain: ${legs.join(' → ')}`);
  const laya = input.laya;
  if (laya) {
    const stateText =
      laya.state === 'ok'
        ? 'reachable'
        : laya.state === 'down'
          ? `unreachable${laya.probeError ? ` (${laya.probeError})` : ''}`
          : 'not probed yet (probes on first use)';
    const id = laya.identity;
    const reported = id?.model && id.version ? `${id.model}@${id.version}` : null;
    const label = reported
      ? `laya:${reported} (reported by the sidecar${id?.backend ? `, ${id.backend}` : ''}; ` +
        `configured ${laya.checkpoint})`
      : `laya:${laya.checkpoint} (configured)`;
    lines.push(
      `│ Laya (${laya.mode}): ${label} @ ${laya.endpoint} — ${stateText} · threshold ${laya.confidence_threshold}`
    );
    // A configured `<model>@<version>` is comparable; a free-form string (a
    // repo path) is not, so only the former can be a mismatch.
    const configuredId = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
      laya.checkpoint
    );
    if (reported && configuredId && laya.checkpoint !== reported) {
      lines.push(
        `│   ⚠ configured checkpoint ${laya.checkpoint} ≠ reported ${reported} — the sidecar serves another model`
      );
    }
    if (id?.headMatches === false) {
      lines.push(
        '│   ⚠ the sidecar serves a different head than the router builds — answers measure prompt drift, not the model'
      );
    }
  }
  // Today's mix (Phase 0): makes a category skew visible without digging
  // through the router log. (The old example here said "60 % fallback" — the
  // retired category, which `continue` replaced in v2-r3.)
  const counts = input.counts;
  if (counts && counts.total > 0) {
    const byFreq = (m: Record<string, number>): [string, number][] =>
      Object.entries(m).sort((a, b) => b[1] - a[1]);
    const pct = (n: number): number => Math.round((n / counts.total) * 100);
    lines.push(
      `│ Today: ${counts.total} classified — ${byFreq(counts.bySource)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')}`
    );
    lines.push(
      `│ Categories: ${byFreq(counts.byCategory)
        .map(([k, n]) => `${k} ${n} (${pct(n)}%)`)
        .join(', ')}`
    );
  }
  return lines;
}

/** Blocks `/router config <block>` shows in detail (plan Phase 3). */
const CONFIG_BLOCKS = ['classifier', 'integrations'] as const;

/** Reference lines for `/router config` and its usage: one table, shared with the completions. */
function configUsageLines(): string[] {
  const width = Math.max(...CONFIG_SUBCOMMANDS.map((s) => s.usage.length)) + 2;
  return [
    'Usage:',
    '  /router config                          show config sources, the chain, integrations, exclude rules',
    ...CONFIG_SUBCOMMANDS.map((s) => `  /router ${s.usage.padEnd(width)}${s.summary}`),
  ];
}

/**
 * Cache-aware compaction state line (Phase 5b, implemented): the master
 * switch plus whatever thresholds are configured. OFF with no thresholds is
 * the shipped default — measurement only (Phase 5a), no hints, no
 * auto-compaction.
 */
function compactionStateLine(cfg: {
  context_budget?: {
    enabled?: boolean;
    soft_tokens?: number;
    hard_tokens?: number;
    cache_ttl_s?: number;
  };
}): string {
  const b = cfg.context_budget;
  const enabled = b?.enabled ? 'on' : 'off';
  const bits: string[] = [];
  if (b && (b.soft_tokens ?? 0) > 0) bits.push(`soft ${b.soft_tokens} tok`);
  if (b && (b.hard_tokens ?? 0) > 0) bits.push(`hard ${b.hard_tokens} tok`);
  if (b && (b.cache_ttl_s ?? 0) > 0) bits.push(`ttl ${b.cache_ttl_s}s`);
  const detail = bits.length
    ? ` (${bits.join(', ')})`
    : ' (no soft_tokens/hard_tokens configured — triggers disarmed)';
  return `Compaction (context_budget): ${enabled}${detail}`;
}

/**
 * `/router config integration <name> on|off|<mode>`: one write to the user
 * layer, then the authoritative re-read. A mode implies on. The reply states
 * what is in effect afterwards, not what was asked for.
 */
function setIntegration(rt: CommandDeps, arg: string): string {
  const usage = 'Usage: /router config integration <name> on|off|<mode>';
  const parts = arg.split(/\s+/).filter(Boolean);
  if (parts.length > 2) return [`Not written: too many arguments.`, usage].join('\n');
  const [name = '', word = ''] = parts;
  const configured = { ...(rt.cfg.integrations ?? {}) };
  if (!name) {
    return [...formatIntegrationLines(configured, INTEGRATION_SPECS), '', usage].join('\n');
  }
  if (!Object.hasOwn(INTEGRATION_SPECS, name)) {
    return [
      `"${name}" is not a known integration. Known: ${Object.keys(INTEGRATION_SPECS).join(', ')}.`,
      usage,
    ].join('\n');
  }
  const spec = INTEGRATION_SPECS[name];
  const patch =
    word === 'on'
      ? { enabled: true }
      : word === 'off'
        ? { enabled: false }
        : word
          ? { enabled: true, mode: word }
          : undefined;
  if (!patch) {
    return [usage, `Allowed modes: ${spec.modes.join(', ')}`].join('\n');
  }
  const problem = checkIntegrationPatch(spec, patch);
  if (problem) return [`Not written: ${problem}.`, usage].join('\n');

  const res = openUserConfigStore().applyDelta({ integrations: { [name]: patch } });
  if (!res.ok) return res.error;
  rt.load();
  // The validator turns an invalid block off and a higher layer can win; the
  // reload shows what is actually in effect.
  const block = (
    (rt.cfg.integrations ?? {}) as Record<string, { enabled?: unknown; mode?: string } | undefined>
  )[name];
  const enabledNow = block?.enabled === true;
  const matches =
    (patch.enabled === undefined || block?.enabled === patch.enabled) &&
    (patch.mode === undefined || block?.mode === patch.mode);
  if (matches) {
    const state = enabledNow ? `on (${block?.mode ?? spec.defaultMode})` : 'off';
    const reply = `${name} is ${state} — saved to ${res.written}; applies now.`;
    // Config plan 2026-11-14 item 15 (owner decision 2026-11-15): switching
    // Laya on without any installed weights points at the installer. The
    // command itself never downloads anything.
    if (name === 'laya' && enabledNow && !hasAnyInstall()) {
      return [
        reply,
        'No Laya weights are installed under the models root — install them with',
        '`pi-laya-model install <model>@<version>` (list what the manifest offers with',
        '`pi-laya-model models`); see the skill `router-laya-install`.',
      ].join('\n');
    }
    return reply;
  }
  const project = readConfigLayers({ extDir: path.dirname(rt.cfgPath), cwd: process.cwd() }).find(
    (layer) => layer.origin === 'project'
  );
  const overriding = (project?.integrations?.[name] ?? {}) as { enabled?: unknown; mode?: unknown };
  const overridden =
    (patch.enabled !== undefined &&
      overriding.enabled !== undefined &&
      overriding.enabled !== patch.enabled) ||
    (patch.mode !== undefined && overriding.mode !== undefined && overriding.mode !== patch.mode);
  if (overridden) {
    return `${name} is not changed — the project config (${project?.path}) sets it. Saved to ${res.written}; remove that key from the project file to use this setting.`;
  }
  if (patch.enabled === true && !enabledNow) {
    return `${name} is still off — saved to ${res.written}, but the block is invalid. See the router log warning for integrations.${name}.`;
  }
  return `${name} did not take effect — saved to ${res.written}; see the router log for integrations.${name}.`;
}

/** `/router config compaction on|off` — persist the master switch to the user layer, apply live. */
function setCompaction(rt: CommandDeps, on: boolean): string {
  const res = openUserConfigStore().applyDelta({ context_budget: { enabled: on } });
  if (!res.ok) return res.error;
  // Immediate in-memory effect, then the authoritative re-read (same path as
  // session_start) so the running router sees exactly what the next start will.
  rt.cfg.context_budget = { ...rt.cfg.context_budget, enabled: on };
  rt.load();
  const armed =
    (rt.cfg.context_budget?.soft_tokens ?? 0) > 0 || (rt.cfg.context_budget?.hard_tokens ?? 0) > 0;
  const note = on
    ? armed
      ? 'Armed: cold turn boundaries over the thresholds compact (or hint while disabled); over hard compacts regardless.'
      : 'No soft_tokens/hard_tokens configured yet — set them in context_budget to arm the triggers; without thresholds nothing compacts and no hints fire.'
    : 'Thresholds still configure the "compacting now would pay off" hints; only the automatic compaction is off.';
  return [
    `Cache-aware auto-compaction ${on ? 'enabled' : 'disabled'} — saved to ${res.written}; applies from the next turn boundary (never mid-turn).`,
    note,
  ].join('\n');
}

/**
 * Every model ref Pi currently offers, BEFORE the exclude rules: the router's
 * own allDiscoveredRefs() is post-exclude, so a rule already in effect would
 * always count 0 matches against it.
 */
function rawDiscoveredRefs(
  rt: CommandDeps,
  ctx: { modelRegistry?: { getAvailable(): Array<{ provider: string; id: string }> } }
): string[] {
  const refs = new Set(rt.router.allDiscoveredRefs());
  for (const m of ctx.modelRegistry?.getAvailable() ?? []) refs.add(`${m.provider}/${m.id}`);
  for (const m of rt.cache.available_models ?? []) refs.add(`${m.provider}/${m.id}`);
  const groupNames = new Set(Object.keys(rt.cfg.model_groups ?? {}));
  return [...refs].filter((r) => !isVirtualGroupRef(r, groupNames));
}

/** How many of `refs` a single exclude rule drops (the rule alone, not the union). */
function countMatches(rt: CommandDeps, rule: ExcludeRules, refs: string[]): number {
  return refs.filter((ref) => isExcluded(ref, { rules: rule, cfg: rt.cfg, cache: rt.cache }))
    .length;
}

/** `/router config` (bare): sources with origin, every exclude rule with origin + match count, hints. */
function formatConfigDisplay(rt: CommandDeps, layers: ConfigLayerView[], refs: string[]): string {
  const lines: string[] = [
    'Router config',
    '',
    'Sources (later layers override earlier ones; exclude lists are unioned):',
  ];
  for (const l of layers) {
    const note = l.error ? ` (unusable: ${l.error})` : l.present ? '' : ' (not present)';
    lines.push(`  ${l.origin.padEnd(8)} ${l.path}${note}`);
  }
  lines.push('', 'Exclude rules:');
  let any = false;
  for (const l of layers) {
    const tag = `[${l.origin}]`.padEnd(9);
    const kinds = ['models', 'providers', 'paid_models_from'] as const;
    for (const kind of kinds) {
      for (const pattern of l.exclude[kind] ?? []) {
        any = true;
        const n = countMatches(rt, { [kind]: [pattern] }, refs);
        lines.push(`  ${tag} ${kind}: ${pattern}  → matches ${n} discovered model(s)`);
      }
    }
  }
  if (!any) lines.push('  (none)');
  lines.push(
    '',
    'Classifier chain:',
    ...formatClassifierChain(describeClassifierChain(rt.cfg)),
    '',
    'Integrations:',
    ...formatIntegrationLines({ ...(rt.cfg.integrations ?? {}) }, INTEGRATION_SPECS).map(
      (line) => `  ${line}`
    ),
    '',
    compactionStateLine(rt.cfg),
    '',
    ...configUsageLines()
  );
  lines.push(
    'Shipped and project entries cannot be removed with unexclude — only user-layer entries can.'
  );
  return lines.join('\n');
}

const SCAN_CYCLE_NOTE =
  'The live pipeline applies it from the next turn; it takes full effect at the next scan cycle for persisted group lists.';

/**
 * A bare name (no "/" and no "*") can never match a model ref — exclude.models
 * globs are anchored against "provider/model" — so it can only mean a provider.
 */
function isBareProviderName(pattern: string): boolean {
  return !pattern.includes('/') && !pattern.includes('*');
}

/** `/router config exclude <pattern>` — validate, persist to the user layer, apply live. */
function excludePattern(
  rt: CommandDeps,
  ctx: Parameters<typeof rawDiscoveredRefs>[1],
  pattern: string
): string {
  if (!pattern) return ['Missing pattern.', '', ...configUsageLines()].join('\n');
  const invalid = validateExcludePattern(pattern);
  if (invalid) return invalid;

  const refs = rawDiscoveredRefs(rt, ctx);
  const bareProvider = isBareProviderName(pattern);
  if (bareProvider && !refs.some((r) => r.split('/')[0] === pattern)) {
    return [
      `"${pattern}" is not a known provider, and a bare name never matches a model ref.`,
      `Use provider/model, a glob such as */${pattern}*, or one of the known providers: ${[...new Set(refs.map((r) => r.split('/')[0]))].sort().join(', ') || '(none discovered)'}.`,
    ].join('\n');
  }

  const store = openUserConfigStore();
  // A corrupt user file reads as no config here; applyDelta then refuses to write over it.
  const config = store.read().config;
  const kind = bareProvider ? 'providers' : 'models';
  const current = userExcludeList(config, kind);
  if (current.includes(pattern))
    return `"${pattern}" is already in the user config's exclude list.`;

  const matches = countMatches(rt, { [kind]: [pattern] }, refs);
  const next = [...current, pattern];
  const res = store.applyDelta({ exclude: { [kind]: next } });
  if (!res.ok) return res.error;

  // Immediate in-memory effect, then the authoritative re-read (same path as
  // session_start) so the running router sees exactly what the next start will.
  rt.cfg.exclude = {
    ...rt.cfg.exclude,
    [kind]: [...new Set([...(rt.cfg.exclude?.[kind] ?? []), pattern])],
  };
  rt.load();
  return [
    `Excluded ${bareProvider ? `provider "${pattern}"` : `"${pattern}"`} — it matches ${matches} discovered model(s) right now.`,
    `Saved to ${res.written}. ${SCAN_CYCLE_NOTE}`,
  ].join('\n');
}

/**
 * The exclude kind of a non-user layer whose provider-level rules
 * (exclude.providers / exclude.paid_models_from) still cover the pattern's
 * models, or null. Review Minor 2: the unexclude notes used to check only
 * exclude.models, so a provider-level exclusion in another layer produced
 * a misleading "not in any exclude list" / missing "still excluded" note.
 */
function coveringProviderRuleKind(
  layer: ConfigLayerView,
  pattern: string
): 'providers' | 'paid_models_from' | null {
  const prov = pattern.split('/')[0];
  const covers = (entries: string[] | undefined): boolean =>
    (entries ?? []).some((e) => e === prov || (e.includes('*') && globMatcher(e)(prov)));
  if (covers(layer.exclude.providers)) return 'providers';
  if (covers(layer.exclude.paid_models_from)) return 'paid_models_from';
  return null;
}

/** `/router config unexclude <pattern>` — user-layer entries only (D4). */
function unexcludePattern(rt: CommandDeps, layers: ConfigLayerView[], pattern: string): string {
  if (!pattern) return ['Missing pattern.', '', ...configUsageLines()].join('\n');
  const user = layers.find((l) => l.origin === 'user')!;
  if (user.error) return `Not written — ${user.error}; fix or remove it first.`;
  const others = layers.filter(
    (l) =>
      l.origin !== 'user' &&
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a false from includes() must still reach the provider-rule check
      (l.exclude.models?.includes(pattern) || coveringProviderRuleKind(l, pattern) !== null)
  );

  // A bare provider name lives in exclude.providers; everything else in exclude.models.
  const kind =
    isBareProviderName(pattern) && (user.exclude.providers ?? []).includes(pattern)
      ? 'providers'
      : 'models';
  const current = user.exclude[kind] ?? [];
  if (!current.includes(pattern)) {
    if (others.length === 0) return `"${pattern}" is not in any exclude list.`;
    const first = others[0];
    if (first.exclude.models?.includes(pattern)) {
      return `"${pattern}" is part of the ${first.origin} defaults — removable only in that layer (shipped defaults empty in the ADR-0025 B3 round).`;
    }
    const coverKind = coveringProviderRuleKind(first, pattern);
    return `"${pattern}" is not in any models exclude list, but "${pattern.split('/')[0]}" models stay excluded by the ${first.origin} layer (exclude.${coverKind}).`;
  }

  const res = openUserConfigStore().applyDelta({
    exclude: { [kind]: current.filter((p) => p !== pattern) },
  });
  if (!res.ok) return res.error;

  if (others.length === 0 && rt.cfg.exclude?.[kind]) {
    rt.cfg.exclude = {
      ...rt.cfg.exclude,
      [kind]: rt.cfg.exclude[kind].filter((p) => p !== pattern),
    };
  }
  rt.load();
  const still = others.length
    ? ` It is still excluded by the ${others.map((l) => l.origin).join(' and ')} layer.`
    : '';
  return `Removed "${pattern}" from the user config (${res.written}).${still} ${SCAN_CYCLE_NOTE}`;
}

function userExcludeList(
  config: Record<string, unknown> | undefined,
  kind: 'models' | 'providers'
): string[] {
  const exclude = config?.exclude as Record<string, unknown> | undefined;
  const list = exclude?.[kind];
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
}

/** `/router config ...` — returns the text to show. */
/** The command context as far as `/router config` needs it: the model registry. */
interface ConfigCommandCtx {
  modelRegistry?: {
    getAvailable(): Array<{ provider: string; id: string }>;
    find?(provider: string, id: string): unknown;
  };
}

/** A value as a reply shows it. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'unset';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : JSON.stringify(value);
}

/**
 * The first model reference in a value that pi's registry does not know, or
 * undefined. Candidates and cloud models enter only through pi (AGENTS §9).
 */
function unknownModelRef(
  spec: { ref?: 'provider-model' | 'ollama-model' },
  value: unknown,
  ctx: ConfigCommandCtx
): string | undefined {
  if (spec.ref !== 'provider-model') return undefined;
  const refs = Array.isArray(value) ? value : [value];
  for (const ref of refs as string[]) {
    const slash = ref.indexOf('/');
    const known = ctx.modelRegistry?.find?.(ref.slice(0, slash), ref.slice(slash + 1));
    if (!known) return ref;
  }
  return undefined;
}

/** A table write ready for the store, or the refusal text that says why not. */
type PreparedPatch = { patch: ConfigPatch } | { refusal: string };

/** Parses and checks the words of one set; the same check for the command and the menu. */
function setPatchFor(
  spec: ConfigKeySpec,
  keyPath: string,
  raw: string,
  ctx: ConfigCommandCtx
): PreparedPatch {
  const parsed = parseConfigValue(spec, raw);
  if ('error' in parsed) return { refusal: `Not written: ${parsed.error}.` };
  const unknown = unknownModelRef(spec, parsed.value, ctx);
  if (unknown) return { refusal: `Not written: pi does not know the model "${unknown}".` };
  return { patch: { path: keyPath, value: parsed.value } };
}

/**
 * Writes one table patch to the user layer, reloads, and replies with the
 * value in effect, a project-layer override when there is one, and the chain.
 * A set is overridden when the value in effect is not the saved one (compared
 * by value: lists are new arrays on every load); an unset is overridden when
 * the project layer sets the key, under its path or a pre-2.0 name the loader
 * still reads.
 */
function commitConfigPatch(rt: CommandDeps, keyPath: string, patch: ConfigPatch): string {
  const res = openUserConfigStore().applyDelta({ paths: [patch] });
  if (!res.ok) return res.error;
  rt.load();
  const project = readConfigLayers({ extDir: path.dirname(rt.cfgPath), cwd: process.cwd() }).find(
    (layer) => layer.origin === 'project'
  );
  const effective = getLeaf(rt.cfg, keyPath);
  const projectSets = layerSetsKey(project?.config, keyPath);
  const overridden =
    projectSets && ('value' in patch ? !isDeepStrictEqual(effective, patch.value) : true);
  const projectWins = 'value' in patch ? 'overrides the saved value' : 'sets it';
  const headline = overridden
    ? `${keyPath} is still ${describeValue(effective)}: the project config (${project?.path}) ${projectWins}.`
    : `${keyPath} is ${describeValue(effective)} — saved to ${res.written}; applies now.`;
  return [headline, '', 'Chain:', ...formatClassifierChain(describeClassifierChain(rt.cfg))].join(
    '\n'
  );
}

/**
 * `/router config set <path> <value>` and `unset <path>` (config plan Phase 2):
 * one table key, validated against the table, then the authoritative reload.
 */
function setConfigValue(
  rt: CommandDeps,
  ctx: ConfigCommandCtx,
  arg: string,
  unset: boolean
): string {
  const usage = unset
    ? 'Usage: /router config unset <path>'
    : 'Usage: /router config set <path> <value>';
  const [, keyPath = '', rest = ''] = arg.match(/^(\S*)\s*(.*)$/)!;
  if (!keyPath || (!unset && !rest.trim())) return usage;
  const spec = configKey(keyPath);
  if (!spec) {
    const near = closestKey(
      keyPath,
      CONFIG_KEYS.map((k) => k.path)
    );
    return [
      `Not written: "${keyPath}" is not a documented key${near ? `; did you mean "${near}"?` : ''}.`,
      usage,
    ].join('\n');
  }
  if (spec.via === 'alias') {
    return `Not written: ${keyPath} is changed with /router ${spec.alias}.`;
  }
  if (spec.via === 'file-only') {
    return `Not written: ${keyPath} is hand-edited only (in the user layer, router-config.user.json).`;
  }
  if (unset) return commitConfigPatch(rt, keyPath, { path: keyPath, unset: true });
  const prepared = setPatchFor(spec, keyPath, rest, ctx);
  if ('refusal' in prepared) return prepared.refusal;
  return commitConfigPatch(rt, keyPath, prepared.patch);
}

const CONFIG_BLOCK_TITLES: Record<(typeof CONFIG_BLOCKS)[number], string> = {
  classifier: 'which models classify a prompt, and whether cloud models may see it',
  integrations: 'optional integrations; each is switched with the command shown',
};

/**
 * `/router config classifier|integrations`: every table key of the block, the
 * value in effect, the shipped default and how the key is changed. The
 * classifier view ends with the chain the settings produce.
 */
function configBlockView(rt: CommandDeps, block: (typeof CONFIG_BLOCKS)[number]): string {
  const specs = CONFIG_KEYS.filter((k) => k.path.startsWith(`${block}.`));
  const width = Math.max(...specs.map((s) => s.path.length)) + 2;
  const lines = [`${block} — ${CONFIG_BLOCK_TITLES[block]}`, ''];
  for (const spec of specs) {
    const how =
      spec.via === 'set'
        ? '/router config set'
        : spec.via === 'alias'
          ? `/router ${spec.alias}`
          : 'hand-edit (user layer)';
    lines.push(
      `  ${spec.path.padEnd(width)}${describeValue(getLeaf(rt.cfg, spec.path)).padEnd(12)}[shipped: ${spec.shipped}]  ${how}`
    );
  }
  if (block === 'classifier') {
    lines.push('', 'Chain:', ...formatClassifierChain(describeClassifierChain(rt.cfg)));
  }
  return lines.join('\n');
}

/** The dialogs the guided menu uses: the subset of pi's UI context it needs. */
interface WizardUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
}

type WizardCtx = ConfigCommandCtx & { ui: WizardUi };

const WIZARD_SHOW = 'Show the overview';
const WIZARD_HAND = 'Hand-edited keys (file only)';
const WIZARD_DONE = 'Done';
/** The menu loops until Done or a cancel; the bound stops a script that never answers Done. */
const WIZARD_MAX_ROUNDS = 25;
const CONFIG_NO_MENU_NOTE =
  'The guided menu needs the terminal (TUI mode). Without it, change a setting with /router config set <path> <value> or /router config unset <path>.';

function handEditLines(): string[] {
  return [
    'Hand-edited keys (change them in the user layer, router-config.user.json):',
    ...CONFIG_KEYS.filter((k) => k.via === 'file-only').map((k) => `  ${k.path} — ${k.meaning}`),
  ];
}

/**
 * One key of the menu. Switches ask yes/no, enumerations offer their values,
 * lists and model refs take text. Integration keys go through the integration
 * switch, the same write `/router config integration` makes.
 */
async function editWizardKey(
  rt: CommandDeps,
  ctx: WizardCtx,
  spec: ConfigKeySpec
): Promise<string | undefined> {
  const integration = spec.path.match(/^integrations\.([a-z_]+)\.(enabled|mode)$/);
  const viaIntegration = spec.via === 'alias' && integration !== null;
  if (spec.kind === 'boolean') {
    const current = getLeaf(rt.cfg, spec.path) === true;
    const target = !current;
    const word = target ? 'on' : 'off';
    const ok = await ctx.ui.confirm(
      'Router config',
      `Set ${spec.path} to ${word}? (now ${current ? 'on' : 'off'})`
    );
    if (!ok) return undefined;
    return viaIntegration
      ? setIntegration(rt, `${integration[1]} ${word}`)
      : commitConfigPatch(rt, spec.path, { path: spec.path, value: target });
  }
  if (spec.kind === 'enum') {
    const value = await ctx.ui.select(spec.path, [...(spec.values ?? [])]);
    if (value === undefined) return undefined;
    return viaIntegration
      ? setIntegration(rt, `${integration[1]} ${value}`)
      : commitConfigPatch(rt, spec.path, { path: spec.path, value });
  }
  if (spec.via !== 'set') return undefined;
  const placeholder =
    spec.kind === 'string-list'
      ? 'comma-separated provider/id list'
      : spec.ref === 'ollama-model'
        ? 'ollama/<name>'
        : 'provider/id';
  const text = await ctx.ui.input(spec.path, placeholder);
  if (text === undefined || text.trim() === '') return undefined;
  const prepared = setPatchFor(spec, spec.path, text, ctx);
  if ('refusal' in prepared) return prepared.refusal;
  return commitConfigPatch(rt, spec.path, prepared.patch);
}

/**
 * `/router config` in TUI mode: pick a wizard key, answer its question, and
 * come back to the menu with the new value. Offers only the keys the table
 * marks `wizard`; file-only keys are listed with their meaning, not edited.
 */
async function runConfigWizard(rt: CommandDeps, ctx: WizardCtx): Promise<void> {
  for (let round = 0; round < WIZARD_MAX_ROUNDS; round++) {
    const byLabel = new Map<string, ConfigKeySpec>();
    for (const spec of CONFIG_KEYS.filter((k) => k.wizard === true)) {
      byLabel.set(`${spec.path} — ${describeValue(getLeaf(rt.cfg, spec.path))}`, spec);
    }
    const options = [WIZARD_SHOW, ...byLabel.keys(), WIZARD_HAND, WIZARD_DONE];
    const choice = await ctx.ui.select('Router config — choose a setting to change', options);
    if (choice === undefined || choice === WIZARD_DONE) return;
    if (choice === WIZARD_SHOW) {
      ctx.ui.notify(handleConfigCommand(rt, ctx, 'show'), 'info');
      continue;
    }
    if (choice === WIZARD_HAND) {
      ctx.ui.notify(handEditLines().join('\n'), 'info');
      continue;
    }
    const spec = byLabel.get(choice);
    if (!spec) return;
    const reply = await editWizardKey(rt, ctx, spec);
    if (reply) ctx.ui.notify(reply, reply.startsWith('Not written') ? 'warning' : 'info');
  }
}

function handleConfigCommand(rt: CommandDeps, ctx: ConfigCommandCtx, rest: string): string {
  const [, sub, arg] = rest.match(/^(\S*)\s*(.*)$/)!;
  const layers = (): ConfigLayerView[] =>
    readConfigLayers({ extDir: path.dirname(rt.cfgPath), cwd: process.cwd() });
  if (!sub || sub === 'show') return formatConfigDisplay(rt, layers(), rawDiscoveredRefs(rt, ctx));
  if (sub === 'set') return setConfigValue(rt, ctx, arg, false);
  if (sub === 'unset') return setConfigValue(rt, ctx, arg, true);
  if ((CONFIG_BLOCKS as readonly string[]).includes(sub)) {
    return configBlockView(rt, sub as (typeof CONFIG_BLOCKS)[number]);
  }
  if (sub === 'compaction') {
    if (arg === 'on') return setCompaction(rt, true);
    if (arg === 'off') return setCompaction(rt, false);
    return [compactionStateLine(rt.cfg), '', ...configUsageLines()].join('\n');
  }
  if (sub === 'integration') return setIntegration(rt, arg);
  if (sub === 'exclude') return excludePattern(rt, ctx, arg);
  if (sub === 'unexclude') return unexcludePattern(rt, layers(), arg);
  return ['Unknown config subcommand: ' + sub, '', ...configUsageLines()].join('\n');
}

interface RouterSubcommand {
  /** First word of the argument. */
  name: string;
  /** Usage after "/router ", as shown in the description and the overview. */
  usage: string;
  /** One line for the overview's command list. */
  summary: string;
  /** Autocomplete entries for this subcommand. */
  completions: AutocompleteItem[];
  /** Nested subcommands listed under this one (`config`). */
  children?: readonly RouterSubcommand[];
}

/**
 * The `/router config …` subcommands, nested under the `config` entry of
 * ROUTER_SUBCOMMANDS. Single source for the `config [a|b|…]` part of the
 * command description, the `config …` completions and the config usage
 * lines (configUsageLines). Handling stays in the handler.
 */
const CONFIG_SUBCOMMANDS: readonly RouterSubcommand[] = [
  {
    name: 'show',
    usage: 'config show',
    summary: 'Config overview: sources, chain, integrations, exclude rules (every mode)',
    completions: [
      {
        value: 'config show',
        label: 'config show',
        description: 'Show the config overview; works in every run mode',
      },
    ],
  },
  {
    name: 'set',
    usage: 'config set <path> <value>',
    summary: 'Write one classifier setting to the user config (validated, applies now)',
    completions: [
      {
        value: 'config set',
        label: 'config set <path> <value>',
        description:
          'Write one classifier setting, checked against the key table, to the user config',
      },
    ],
  },
  {
    name: 'unset',
    usage: 'config unset <path>',
    summary: 'Remove one classifier setting from the user config',
    completions: [
      {
        value: 'config unset',
        label: 'config unset <path>',
        description: 'Remove one classifier setting from the user config',
      },
    ],
  },
  {
    name: 'classifier',
    usage: 'config classifier',
    summary: 'Classifier settings in effect, how each is changed, and the chain they produce',
    completions: [
      {
        value: 'config classifier',
        label: 'config classifier',
        description: 'Show the classifier settings in effect and the chain they produce',
      },
    ],
  },
  {
    name: 'integrations',
    usage: 'config integrations',
    summary: 'Integration settings in effect and the command that switches each',
    completions: [
      {
        value: 'config integrations',
        label: 'config integrations',
        description: 'Show the integration settings in effect and their switch commands',
      },
    ],
  },
  {
    name: 'exclude',
    usage: 'config exclude <ref|glob|provider>',
    summary: 'Exclude a model, glob or provider from routing (user config, applies now)',
    completions: [
      {
        value: 'config exclude',
        label: 'config exclude <ref|glob|provider>',
        description:
          'Exclude a model/glob/provider from routing (saved to the user config, live without restart)',
      },
    ],
  },
  {
    name: 'unexclude',
    usage: 'config unexclude <ref|glob|provider>',
    summary: 'Remove an exclusion from the user config',
    completions: [
      {
        value: 'config unexclude',
        label: 'config unexclude <ref|glob|provider>',
        description: 'Remove an exclusion from the user config',
      },
    ],
  },
  {
    name: 'integration',
    usage: 'config integration <name> on|off|<mode>',
    summary: 'Switch an optional integration (e.g. laya) on, off or to a mode',
    completions: [
      {
        value: 'config integration',
        label: 'config integration <name> on|off|<mode>',
        description:
          'Switch an optional integration (e.g. laya) on, off or to a mode; saved to the user config',
      },
    ],
  },
  {
    name: 'compaction',
    usage: 'config compaction on|off',
    summary: 'Cache-aware auto-compaction switch (Phase 5b, opt-in)',
    completions: [
      {
        value: 'config compaction',
        label: 'config compaction on|off',
        description: 'Cache-aware auto-compaction flag (Phase 5b, opt-in)',
      },
    ],
  },
];

/**
 * The /router subcommands. Single source for the command description (Pi's
 * palette), the autocomplete list, the command list under the bare overview
 * and the unknown-subcommand reply, so the four cannot drift apart. Handling
 * stays in the handler; test/router-command-help.test.ts pins both sides.
 */
const ROUTER_SUBCOMMANDS: readonly RouterSubcommand[] = [
  {
    name: 'scan',
    usage: 'scan',
    summary: 'Re-discover models, re-scrape GDPval, regenerate config',
    completions: [
      {
        value: 'scan',
        label: 'scan',
        description: 'Re-discover models, re-scrape GDPval, regenerate config',
      },
    ],
  },
  {
    name: 'classifier',
    usage: 'classifier [days]',
    summary: 'Classifier decision summary from the decision log (default 7 days)',
    completions: [
      {
        value: 'classifier',
        label: 'classifier',
        description:
          'Classifier decision summary from the decision log: stages, continue rates, chain exhaustions, chain failures, latency, Laya disagreements ([days], default 7)',
      },
    ],
  },
  {
    name: 'corrections',
    usage: 'corrections [list|clear]',
    summary: 'Saved HINT category corrections: list them, or clear all (ADR-0030)',
    completions: [
      {
        value: 'corrections',
        label: 'corrections',
        description: 'Saved HINT category corrections: list, or clear all',
      },
    ],
  },
  {
    name: 'cost',
    usage: 'cost',
    summary: 'Cost report for all session models and the 1/7/30-day token windows',
    completions: [
      {
        value: 'cost',
        label: 'cost',
        description:
          'Cost report: ALL session models (Req/In/Out/Marginal/Tier) + 1d/7d/30d token windows with ≈ blended-price estimate',
      },
    ],
  },
  {
    name: 'errors',
    usage: 'errors [n]',
    summary: 'Main-session stream failures (default 15, max 50)',
    completions: [
      {
        value: 'errors',
        label: 'errors',
        description:
          'Main-session stream failures — headline count matches the status-line ⚠N err exactly',
      },
      {
        value: 'errors 30',
        label: 'errors <n>',
        description: 'Show up to <n> entries (default 15, max 50)',
      },
    ],
  },
  {
    name: 'blocklist',
    usage: 'blocklist [clear [ref]]',
    summary: 'Models blocked after permanent provider failures; clear all or one',
    completions: [
      {
        value: 'blocklist',
        label: 'blocklist',
        description: 'Show models blocked after permanent provider failures',
      },
      {
        value: 'blocklist clear',
        label: 'blocklist clear',
        description: 'Unblock all models, or one: blocklist clear <provider/model>',
      },
    ],
  },
  {
    name: 'cooldowns',
    usage: 'cooldowns [clear]',
    summary: 'Active rate-limit cooldowns; clear them without a restart',
    completions: [
      {
        value: 'cooldowns',
        label: 'cooldowns',
        description: 'Show active rate-limit cooldowns (ref, remaining, hits)',
      },
      {
        value: 'cooldowns clear',
        label: 'cooldowns clear',
        description:
          'Clear all cooldowns + model-health streaks (incident relief, no restart needed)',
      },
    ],
  },
  {
    name: 'laya',
    usage: 'laya [install|serve|stop]',
    summary: 'Laya classifier: status, install it (confirmed steps), start or stop the sidecar',
    completions: [
      {
        value: 'laya',
        label: 'laya',
        description: 'Laya classifier status: offer, install, ONNX runtime, config',
      },
      {
        value: 'laya install',
        label: 'laya install',
        description: 'Install the Laya classifier — confirmed steps, TUI only',
      },
      {
        value: 'laya serve',
        label: 'laya serve',
        description: 'Start the Laya sidecar (detached; keeps running after pi exits)',
      },
      {
        value: 'laya stop',
        label: 'laya stop',
        description: 'Stop the Laya sidecar this router started',
      },
    ],
  },
  {
    name: 'config',
    usage: `config [${CONFIG_SUBCOMMANDS.map((c) => c.name).join('|')}]`,
    summary:
      'Config overview, classifier and integration settings, exclude rules; edit the user config',
    completions: [
      {
        value: 'config',
        label: 'config',
        description: 'Show config sources, the classifier chain, integrations and exclude rules',
      },
      ...CONFIG_SUBCOMMANDS.flatMap((c) => c.completions),
    ],
    children: CONFIG_SUBCOMMANDS,
  },
];

function routerCommandDescription(): string {
  return `Model router status. Usage: /router [group|${ROUTER_SUBCOMMANDS.map((s) => s.usage).join('|')}]`;
}

/** The command list shown under the bare overview and with an unknown subcommand. */
function routerCommandListLines(): string[] {
  const rows: Array<[string, string]> = [
    ['/router', 'This overview'],
    ['/router <group>', "One group's ranked candidates"],
    // A subcommand with children shows its bare name: the children are named on
    // the line below, so a bracketed list here would say it twice.
    ...ROUTER_SUBCOMMANDS.map((s): [string, string] => [
      `/router ${s.children ? s.name : s.usage}`,
      s.summary,
    ]),
  ];
  const lines = ['Commands:', ...rows.map(([usage, summary]) => `  ${usage}\n      ${summary}`)];
  // A subcommand with children names them in ONE line instead of one entry per
  // child (owner report 2026-11-15: nine `config` entries at two lines each
  // made the footer the longest part of the overview). The usage forms live in
  // the subcommand's own reply, which lists them from the same table.
  for (const s of ROUTER_SUBCOMMANDS) {
    if (!s.children) continue;
    const names = s.children.map((c) => c.name).join(' \u00b7 ');
    lines.push(`      Subcommands: ${names}`);
  }
  return lines;
}

/**
 * The subcommand a typo most likely meant: a close edit distance, else a name
 * the word contains or starts ("rescan" → "scan", "block" → "blocklist").
 */
function nearestSubcommand(word: string, names: readonly string[]): string | undefined {
  return closestKey(word, names) ?? names.find((n) => word.includes(n) || n.startsWith(word));
}

/** Reply for an argument that is neither a handled subcommand nor a group. */
function formatUnknownRouterSubcommand(arg: string): string {
  const first = arg.split(/\s+/)[0];
  const names = ROUTER_SUBCOMMANDS.map((s) => s.name);
  const known = ROUTER_SUBCOMMANDS.find((s) => s.name === first);
  const near = known ? undefined : nearestSubcommand(first, names);
  const hint = known
    ? ` — usage: /router ${known.usage}`
    : near
      ? ` (did you mean "${near}"?)`
      : '';
  return [`Unknown /router subcommand "${arg}"${hint}`, '', ...routerCommandListLines()].join('\n');
}

/**
 * `/router corrections [list|clear]`: the saved HINT category corrections
 * (ADR-0030 Option 1). The listing shows the exact text each correction matches;
 * clear drops all of them and writes the cache at once.
 */
function handleCorrectionsCommand(rt: CommandDeps, sub: string): string {
  if (sub === '' || sub === 'list') {
    const rows = listCorrections(rt.cache.hint_corrections ?? {});
    if (rows.length === 0) return 'No saved HINT corrections.';
    return [
      'Saved HINT corrections (most recent first):',
      ...rows.map((r) => `  ${r.category}  ${r.savedAt}  ${JSON.stringify(r.key)}`),
    ].join('\n');
  }
  if (sub === 'clear') {
    const store = rt.cache.hint_corrections ?? {};
    const dropped = clearCorrections(store);
    rt.cache.hint_corrections = store;
    rt.cacheManager.saveCache();
    return `Cleared ${dropped} saved HINT correction${dropped === 1 ? '' : 's'}.`;
  }
  return 'Usage: /router corrections [list|clear]';
}

/**
 * Generated state (pid, log, snapshot, cache) lives next to the extension unless
 * `PI_ROUTER_STATE_DIR` points elsewhere — the same rule index.ts uses.
 */
function layaStateDir(rt: CommandDeps): string {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through
  return process.env.PI_ROUTER_STATE_DIR || path.dirname(rt.cfgPath);
}

/** The built CLI that carries `serve` (`dist/laya-model-install.js`). */
function layaCliPath(): string {
  return fileURLToPath(new URL('./laya-model-install.js', import.meta.url));
}

/**
 * The endpoint the router talks to, from the EFFECTIVE config — the shipped
 * defaults, the user layer and any project layer, in that order. Reading the
 * user file here would let a project layer's `integrations.laya` be ignored, so
 * `/router laya` would probe one endpoint while the classifier calls another.
 */
function layaEndpoint(rt: CommandDeps): string {
  const endpoint = rt.cfg.integrations?.laya?.endpoint;
  return typeof endpoint === 'string' && endpoint ? endpoint : LAYA_DEFAULT_ENDPOINT;
}

/**
 * A short local probe of the sidecar's /health. Never throws: a sidecar that is
 * down is a normal state, and the status line says so.
 *
 * Two limits, both deliberate: a non-loopback endpoint is not probed at all (a
 * config file must not turn `/router laya` into a scanner of other hosts,
 * including internal services; the rule is `endpointProblem`), and redirects are
 * refused for the same reason.
 */
async function probeLayaHealth(rt: CommandDeps): Promise<{ artifact_sha256?: string } | null> {
  const endpoint = layaEndpoint(rt);
  if (endpointProblem(endpoint)) return null;
  const url = `${endpoint.replace(/\/+$/, '')}/health`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    });
    if (!res.ok) return null;
    return (await res.json()) as { artifact_sha256?: string };
  } catch {
    return null;
  }
}

/**
 * `/router laya` (status, any mode) and `/router laya install` (the wizard, TUI
 * only). The wizard asks before each change; the status changes nothing.
 * Plan: docs/plans/2026-11-17-router-laya-install-command.md.
 */
async function handleLayaCommand(
  rt: CommandDeps,
  ctx: WizardCtx & { mode?: string },
  sub: string
): Promise<string> {
  const deps = defaultLayaInstallDeps({
    // The user layer: the wizard merges onto this and writes it back.
    readLayaBlock: () => {
      const cfg = openUserConfigStore().read().config as
        | { integrations?: { laya?: Record<string, unknown> } }
        | undefined;
      return cfg?.integrations?.laya;
    },
    // What the router runs on. A project layer that enables or repoints Laya must
    // be visible to status and serve — otherwise they describe a different setup.
    readEffectiveLayaBlock: () => rt.cfg.integrations?.laya as Record<string, unknown> | undefined,
    // Through the integrations delta: `checkpoint`, `endpoint` and `timeout_ms` are
    // not `/router config set` keys, so the paths form refuses the whole block.
    writeLayaBlock: (block) => {
      const res = writeLayaConfigBlock(block);
      if (res.ok) rt.load();
      return res;
    },
    stateDir: layaStateDir(rt),
    supervisor: defaultSupervisorDeps(layaCliPath()),
    health: () => probeLayaHealth(rt),
    endpoint: layaEndpoint(rt),
    probeProblem: () => endpointProblem(layaEndpoint(rt)),
  });
  if (sub === '') return (await layaStatus(deps)).join('\n');
  if (sub === 'serve') return runLayaServe(deps);
  if (sub === 'stop') return runLayaStop(deps);
  if (sub === 'install') {
    // Print mode has no dialogs to answer the step questions, so the wizard would
    // stop at every one unanswered. RPC mode does have them (pi emits
    // extension_ui_request and blocks for the client's answer), so it may run.
    if (ctx.mode === 'print') {
      return 'Laya install is interactive (it asks before each step): run /router laya install in the TUI or an RPC client. /router laya shows the status and changes nothing.';
    }
    return runLayaInstall(
      {
        confirm: (title, message) => ctx.ui.confirm(title, message),
        notify: (message, level) => ctx.ui.notify(message, level),
      },
      deps
    );
  }
  return 'Usage: /router laya [install|serve|stop]';
}

export function createCommands(rt: CommandDeps): void {
  // ── Command: /router ───────────────────────────────────────────────────

  rt.pi.registerCommand('router', {
    description: routerCommandDescription(),
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      // Sub-command + group name completion (TAB-friendly).
      const subcommands = ROUTER_SUBCOMMANDS.flatMap((s) => s.completions);
      const groupNames: AutocompleteItem[] = Object.keys(rt.cfg.model_groups ?? {}).map((g) => {
        const desc = rt.cfg.model_groups?.[g]?.description;
        return desc ? { value: g, label: g, description: desc } : { value: g, label: g };
      });
      const all = [...subcommands, ...groupNames];
      const prefix = argumentPrefix.toLowerCase();
      const filtered = prefix ? all.filter((a) => a.value.toLowerCase().startsWith(prefix)) : all;
      return filtered.length ? filtered : null;
    },
    handler: (args, ctx) =>
      runInSession(sessionIdOf(ctx), async () => {
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

          if (arg === 'config' || arg?.startsWith('config ')) {
            const sub = arg.slice('config'.length).trim();
            if (!sub && ctx.mode === 'tui') {
              await runConfigWizard(rt, ctx);
              return;
            }
            const reply = handleConfigCommand(rt, ctx, sub);
            ctx.ui.notify(!sub ? [reply, '', CONFIG_NO_MENU_NOTE].join('\n') : reply, 'info');
            return;
          }

          if (arg === 'laya' || arg?.startsWith('laya ')) {
            const sub = arg.slice('laya'.length).trim();
            ctx.ui.notify(await handleLayaCommand(rt, ctx, sub), 'info');
            return;
          }

          if (arg === 'classifier' || arg?.startsWith('classifier ')) {
            // ADR-0027 Phase 5: a summary of the decision log, so the classifier's
            // behaviour is visible after a restart (the in-memory counters are not).
            const days = parseSummaryDays(arg.slice('classifier'.length));
            ctx.ui.notify(
              days === null
                ? 'Usage: /router classifier [days] (1..90, default 7)'
                : readClassifierSummary(days).join('\n'),
              'info'
            );
            return;
          }

          if (arg === 'corrections' || arg?.startsWith('corrections ')) {
            // ADR-0030 Option 1: list or clear the saved HINT category corrections.
            ctx.ui.notify(
              handleCorrectionsCommand(rt, arg.slice('corrections'.length).trim()),
              'info'
            );
            return;
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
            // Phase 5a: tokens include cacheRead/cacheWrite; the Cache30d column
            // shows the cache-read share of the 30d window.
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
                  const c30 = metricsModule.getCacheUsageAll(30);
                  const out: Record<
                    string,
                    { d1: number; d7: number; d30: number; cacheRead30: number }
                  > = {};
                  for (const ref of new Set([
                    ...Object.keys(d1),
                    ...Object.keys(d7),
                    ...Object.keys(d30),
                  ])) {
                    out[ref] = {
                      d1: d1[ref] ?? 0,
                      d7: d7[ref] ?? 0,
                      d30: d30[ref] ?? 0,
                      cacheRead30: c30[ref]?.cacheRead ?? 0,
                    };
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
            ctx.ui.notify(
              formatErrorsReport(rt.cache, rt.sessionStart, limit, process.pid),
              'info'
            );
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
            routerLog(
              `[router] blocklist cleared manually (${target ?? 'all'}): ${removed} block(s) removed`
            );
            ctx.ui.notify(
              target
                ? removed
                  ? `Unblocked ${target}.`
                  : `${target} was not blocked.`
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
            }
            // Provider circuit breakers clear with the cooldowns (plan D6):
            // incident relief without a restart — same contract as for model
            // cooldowns. Only the volatile open state goes; the persisted
            // trip/hop telemetry stays (plan D7).
            const breakersCleared = clearBreakers(rt.cache);
            rt.cacheManager.saveCache(rt.cache);
            routerLog(
              `[router] cooldowns cleared manually: ${cleared} cooldown(s) + ${healthCleared} model-health streak(s) + ${breakersCleared} breaker(s)`
            );
            ctx.ui.notify(
              `Cooldowns cleared (${cleared} cooldown(s), ${healthCleared} health streak(s), ${breakersCleared} breaker(s)). All models are immediately available for routing again.`,
              'info'
            );
            return;
          }

          // Every handled subcommand returned above. Anything else that is not a
          // group name is a typo: say so instead of silently showing the
          // overview (owner report 2026-11-14: `/router rescan`).
          if (arg && !rt.cfg.model_groups[arg]) {
            ctx.ui.notify(formatUnknownRouterSubcommand(arg), 'warning');
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
          lines.push(
            'GDP: GDPval score (– = none). Lat / tok/s: measured in this session (– = no stream yet).',
            '$/M: list price per million tokens, in / out. use: tokens used in the last 1 / 7 / 30 days.',
            'cost ×N: cost penalty after rate-limit hits. ⛔ Ns: rate-limited for N more seconds.',
            ''
          );

          // Group tables with top 5 models (3 available + up to 2 limited)
          for (const [groupName, g] of Object.entries(rt.cfg.model_groups)) {
            const n = 5;
            const { models: topModels, total } = rt.getTopModels(groupName, n);
            const method =
              g.method === 'pipeline'
                ? g.pipeline!.map((s) => `${s.method}${s.top_k ? `:${s.top_k}` : ''}`).join(' → ')
                : g.method === 'best'
                  ? describeBestMethod(g.score_by, rt.cfg.best_quality_window)
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
            const fallbackInfo =
              g.fallback_groups && g.fallback_groups.length > 0
                ? ` (\u2192 ${g.fallback_groups.join(' \u2192 ')})`
                : '';

            // Group header
            lines.push(
              `┌─ ${groupName}${activeMarker} `.padEnd(72, '─') + ` ${method}${fallbackInfo} ─`
            );

            if (topModels.length === 0 && g.method === 'dynamic') {
              lines.push('│ Routes per prompt via content classification:');
              formatCategoryRoutes().forEach((c) => lines.push(`│   ${c}`));
              // Honest classifier state (2026-10-02 owner finding): the old block
              // hardcoded "via Ollama (gemma2:2b)" while the cloud chain
              // was doing the actual work whenever Ollama is down. Show the backend
              // that last classified plus the live chain state instead.
              lines.push(
                ...formatClassifierStatus({
                  classifier: rt.cfg.classifier,
                  last: getLastClassificationSource(),
                  probedCount: getCachedCloudModels(rt.cache).length,
                  ollamaUp: await isOllamaAvailable(),
                  localChain: resolveLocalClassifierChain(
                    rt.cache,
                    rt.cfg,
                    localClassifierPins(rt.cfg.classifier?.local)
                  ),
                  localProbed: Array.isArray(rt.cache.classifier_local_models),
                  counts: getClassificationCounts(),
                  ...(rt.cfg.integrations?.laya?.enabled
                    ? {
                        laya: {
                          checkpoint: rt.cfg.integrations.laya.checkpoint ?? '?',
                          endpoint: rt.cfg.integrations.laya.endpoint ?? LAYA_DEFAULT_ENDPOINT,
                          confidence_threshold:
                            rt.cfg.integrations.laya.confidence_threshold ?? 0.8,
                          // same safe reading as the chain: only an explicit 'active' decides
                          mode:
                            rt.cfg.integrations.laya.mode === 'active'
                              ? ('active' as const)
                              : ('shadow' as const),
                          state: layaAvailabilityState(),
                          probeError: getLastProbeError() ?? undefined,
                          identity: layaReportedIdentity(),
                        },
                      }
                    : {}),
                })
              );
            } else if (topModels.length === 0) {
              lines.push('│ (no models configured)');
            } else {
              // Name column: the longest shown ref, capped so the table fits a standard terminal
              const MW = Math.min(30, Math.max(5, ...topModels.map((t) => t.ref.length)));
              const rows: OverviewRow[] = topModels.map(({ ref, limited, rank, why }) => {
                const m = rt.getM(ref);
                const prov = ref.split('/')[0];
                const budgetInfo = rt.cache.budget_cache?.[prov];
                let budget = '';
                if (budgetInfo?.window_reset && budgetInfo.remaining_tokens !== undefined) {
                  if (Date.now() < budgetInfo.window_reset) {
                    const windowType = budgetInfo.window_type ?? 'monthly';
                    budget = `${Math.round(budgetInfo.remaining_tokens)}${windowType.substring(0, 1)}`;
                  }
                }
                return {
                  rank,
                  ref,
                  // Unscraped and unconfigured GDPval stays unknown: the ranking's 50 is not a score
                  gdpval:
                    metricsModule.lookupGdp(ref) ?? rt.cfg.model_metrics?.[ref]?.gdpval ?? null,
                  // Measured in this process or explicitly configured by the user
                  // (src/overview-table.ts displayMetricsFor — placeholders dash).
                  ...displayMetricsFor(m, rt.cfg.model_metrics?.[ref]),
                  price: costColumnFor(ref, rt),
                  usage: [rt.getUsage(ref, 1), rt.getUsage(ref, 7), rt.getUsage(ref, 30)],
                  budget,
                  limited,
                  limitSecs: limited ? rt.limitSecs(ref) : 0,
                  costMux: rt.costMux(prov),
                  current: rt.curModel === ref,
                  ...(why ? { why } : {}),
                };
              });
              lines.push(...formatOverviewTable(rows, MW));
            }
            // Footer: show total count if more than shown
            if (total > n) {
              lines.push(`│    … +${total - n} more (sorted by ${g.method})`);
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

          // Provider circuit breaker (ADR-0026, generalizes ADR-0016's
          // local-only watchdog line): one line per open breaker — ANY provider,
          // cloud included — with the remaining skip time and the persisted
          // trip/avoided-hop counters (plan D6/D7). Providers whose breaker
          // closed still show their telemetry: it is the tuning evidence that
          // survives restarts. The fix hint is generic per provider class
          // (ADR-0025 class A): local → restart the daemon, cloud → check the
          // provider/extension.
          {
            const stats = rt.cache.provider_breaker_stats ?? {};
            const openByProvider = new Map(
              openBreakers(rt.cache).map((b) => [b.provider, b.until])
            );
            const providers = [
              ...new Set([...Object.keys(stats), ...openByProvider.keys()]),
            ].sort();
            if (providers.length > 0) {
              lines.push('├─ Provider breaker '.padEnd(72, '─'));
              for (const provider of providers) {
                const st = stats[provider];
                const counters = st
                  ? `, ${st.trips} trip(s), ${st.avoided_hops} hop(s) avoided`
                  : '';
                const until = openByProvider.get(provider);
                if (until !== undefined) {
                  const secs = Math.max(0, Math.ceil((until - Date.now()) / 1000));
                  const hint = isLocalProviderName(provider)
                    ? wedgeFixHint(provider)
                    : 'check the provider/extension (e.g. reload the session); the breaker clears on the next success';
                  lines.push(
                    `│ ⚠ ${provider} looks wedged — skipped for ${secs}s${counters}. Fix: ${hint}.`
                  );
                } else {
                  lines.push(`│ ⏱ ${provider}: breaker closed${counters}.`);
                }
              }
            }
          }

          // Optional integrations (Laya, …): listed even when off, with the switch-on command
          lines.push('├─ Integrations '.padEnd(72, '─'));
          for (const line of formatIntegrationLines(
            { ...(rt.cfg.integrations ?? {}) },
            INTEGRATION_SPECS
          )) {
            lines.push(`│ ${line}`);
          }

          // Learned blocklist summary (details: /router blocklist)
          const blocked = activeBlocks(rt.cache);
          if (blocked.length) {
            lines.push('├─ Blocked (permanent provider failures) '.padEnd(72, '─'));
            lines.push(`│ 🚫 ${blocked.length} model(s) — see /router blocklist`);
          }

          lines.push('└' + '─'.repeat(71));
          lines.push('', ...routerCommandListLines());
          ctx.ui.notify(lines.join('\n'), 'info');
        } finally {
          // Always restore previous session context
          rt.sessionCtx = previousSessionCtx;
          rt.router.setSessionCtx(previousSessionCtx);
        }
      }),
  });
}
