/**
 * pi tool registrations, extracted from index.ts (refactor plan
 * 2026-10-02, task 10): bulk_read, set_model_from_group, resolve_model_group,
 * update_model_metrics. Tool names, flags and schemas are byte-identical —
 * these are user-visible API surface (plan invariant). Note:
 * set_model_from_group pins the group on the session branch (virtual-models
 * migration step 2, docs/plans/2026-11-21-virtual-models-migration.md): the
 * next route() applies it and returns the pinned group's model. Pure code
 * motion otherwise.
 */

import { executeBulkRead } from './bulk-read.ts';
import { routerLog } from './logger.ts';
import { runAsSubCall } from './subcall-scope.ts';
import { runInSession, sessionIdOf } from './turn-state.ts';
import {
  VIRTUAL_PROVIDER,
  VIRTUAL_MODEL_ID,
  dispatchGroupOf,
  type PinHandoff,
} from './virtual-selection.ts';
import * as metricsModule from './metrics.ts';
import { splitRef, textOf } from './utils.ts';
import type { ExtensionContext, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import * as fs from 'node:fs';
import type { Config, Metrics } from './types.ts';

/**
 * Dependencies createTools reads from index.ts's extension closure. Exposed as
 * live accessors (getters, plus setters for state the moved code writes), so
 * every read sees the CURRENT closure value — index.ts reassigns cfg/router/
 * managers on reload, and a captured copy would go stale.
 */
interface ToolDeps {
  readonly cfg: Config;
  readonly cfgPath: string;
  readonly fmtModel: (ref: string, i: number, sel: boolean) => string;
  readonly getM: (ref: string) => Metrics;
  readonly load: () => void;
  /** Pins set during a turn, handed to the selection layer's next route(). */
  readonly pins: PinHandoff;
  readonly pi: ExtensionAPI;
  readonly resolve: (name: string) => { selected: string; candidates: string[] } | null;
}

/**
 * Tool bodies in this file are synchronous (`rt.load()` and the config work
 * are sync); the tool contract still requires `execute` to return a Promise.
 * Wrapping the result is what makes that explicit — an `async` keyword with
 * nothing to await only hides it.
 */
const syncResult = <T>(value: T): Promise<T> => Promise.resolve(value);

/** What set_model_from_group reports: the pin it set (null: released). */
interface PinDetails {
  readonly group: string;
  readonly pinned: string | null;
  readonly selected?: string;
  readonly provider?: string;
  readonly modelId?: string;
}

const pinResult = (
  text: string,
  details: PinDetails
): Promise<{ content: { type: 'text'; text: string }[]; details: PinDetails }> =>
  syncResult({ content: [{ type: 'text', text }], details });

export function createTools(rt: ToolDeps): void {
  // ── Tools ──────────────────────────────────────────────────────────────

  // bulk_read (shunt Layer 2, ADR-0007 revision 2026-09-20): question-based
  // multi-file reading via the delegation group. Registered unconditionally;
  // when delegation is disabled the call throws and the model falls back to
  // targeted reads (no load-order trap at registration time).
  rt.pi.registerTool({
    name: 'bulk_read',
    label: 'Bulk Read',
    description:
      'Ask a question about one or more files and get a concise, precise answer WITHOUT loading the file contents into your context. A cheap reader model reads the files (within the delegation size cap) and answers with structured bullets led by exact names, types, and line numbers. Use it for exploration and multi-file questions; use targeted reads (offset/limit) when you need exact lines for an edit.',
    promptSnippet: 'Answer questions about files cheaply via a reader model',
    promptGuidelines: [
      'Use bulk_read with a question and file paths when you need to understand one or more files instead of reading them fully — the raw file content never enters your context.',
    ],
    parameters: Type.Object({
      question: Type.String({ description: 'What to find out about the files' }),
      paths: Type.Array(Type.String(), { description: 'File paths to read and answer from' }),
    }),
    async execute(
      _id: string,
      params: { question: string; paths: string[] },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ) {
      // The reader stream is a SUB-CALL: it must not become the turn's model
      // (see src/subcall-scope.ts).
      const result = await runInSession(sessionIdOf(ctx), () =>
        runAsSubCall(() => executeBulkRead(params, ctx, rt.cfg, routerLog))
      );
      return {
        ...result,
        details: { tool: 'bulk_read', files: params.paths.length },
      };
    },
  });

  rt.pi.registerTool({
    name: 'set_model_from_group',
    label: 'Set Model from Group',
    description:
      'Pin a model group for this session branch: the router serves that group from the next request on. "none" (or the classifying group) releases the pin. Works only while the session model is router/dynamic.',
    parameters: Type.Object({ group: Type.String({ description: 'Model group name, or "none"' }) }),
    execute(
      _id: string,
      params: { group: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ) {
      rt.load();
      // The pin reaches only route() of router/dynamic; on any other model
      // it would sit in the handoff and fire after a later switch.
      if (ctx.model?.provider !== VIRTUAL_PROVIDER || ctx.model.id !== VIRTUAL_MODEL_ID)
        throw new Error(
          `set_model_from_group pins a group of ${VIRTUAL_PROVIDER}/${VIRTUAL_MODEL_ID}; the session model is ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '(none)'}. Select ${VIRTUAL_PROVIDER}/${VIRTUAL_MODEL_ID} first.`
        );
      const groups = rt.cfg.model_groups ?? {};
      const name = params.group.toLowerCase();
      // "none" and the classifying group both mean: classify again.
      if (name === 'none' || name === dispatchGroupOf(groups)) {
        rt.pins.set(sessionIdOf(ctx), null);
        return pinResult('pin released: the router classifies each request', {
          group: name,
          pinned: null,
        });
      }
      // route() can only serve a group with a registered model; a group the
      // router refused to register (named like a Pi provider, ADR-0019)
      // would fall back on every request.
      const registered = (g: string): boolean => !!ctx.modelRegistry?.find?.(g, g);
      const available = (): string => Object.keys(groups).filter(registered).join(', ');
      if (!Object.prototype.hasOwnProperty.call(groups, name))
        throw new Error(`Unknown group "${params.group}". Available: ${available()}`);
      if (!registered(name))
        throw new Error(
          `Group "${name}" has no registered model, so the router cannot serve it. Available: ${available()}`
        );
      rt.pins.set(sessionIdOf(ctx), name);
      // The expected model is the group's top candidate; the served model
      // appears on the assistant message. A dynamic group resolves per
      // request, so it has none to name.
      const res = rt.resolve(name);
      if (!res) return pinResult(`pinned ${name}`, { group: name, pinned: name });
      const m = rt.getM(res.selected);
      const { provider, modelId } = splitRef(res.selected);
      return pinResult(
        `pinned ${name}: ${res.selected} (gdp:${m.gdpval}, tps:${Math.round(m.throughput_tps)})`,
        { group: name, pinned: name, selected: res.selected, provider, modelId }
      );
    },
  });

  rt.pi.registerTool({
    name: 'resolve_model_group',
    label: 'Resolve Model Group',
    description:
      'Resolve a model group name (planning, design, code_complex, standard, simple) to a concrete provider/model. Use this when you need to select a model for a subagent or task and want the router to pick the best one.',
    parameters: Type.Object({
      group: Type.String({
        description:
          'Model group name: planning, design, code_complex, standard, simple, or any custom group',
      }),
    }),
    execute(
      _id: string,
      params: { group: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext
    ) {
      rt.load();
      const name = params.group.toLowerCase(),
        res = rt.resolve(name);
      if (!res)
        throw new Error(
          `Unknown or empty group "${params.group}". Available: ${Object.keys(rt.cfg.model_groups).join(', ')}`
        );
      const { provider, modelId } = splitRef(res.selected);
      const table = res.candidates.map((r, i) => rt.fmtModel(r, i, i === 0)).join('\n');
      return syncResult({
        content: [
          {
            type: 'text',
            text: `"${name}" (${rt.cfg.model_groups[name].method}) → ${res.selected}\n\n${table}`,
          },
        ],
        details: {
          group: name,
          selected: res.selected,
          provider,
          modelId,
          candidates: res.candidates,
        },
      });
    },
  });

  rt.pi.registerTool({
    name: 'update_model_metrics',
    label: 'Update Model Metrics',
    description:
      'Update runtime metrics (gdpval, throughput, latency) for a model in the router config.',
    parameters: Type.Object({
      model_ref: Type.String({ description: 'Model reference (provider/model-id)' }),
      gdpval: Type.Optional(Type.Number()),
      throughput_tps: Type.Optional(Type.Number()),
      avg_latency_ms: Type.Optional(Type.Number()),
    }),
    execute(
      _id: string,
      p: { model_ref: string; gdpval?: number; throughput_tps?: number; avg_latency_ms?: number },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext
    ) {
      rt.load();
      const e = rt.cfg.model_metrics[p.model_ref] ?? {};
      if (p.gdpval !== undefined) e.gdpval = p.gdpval;
      if (p.throughput_tps !== undefined) e.throughput_tps = p.throughput_tps;
      if (p.avg_latency_ms !== undefined) e.avg_latency_ms = p.avg_latency_ms;
      rt.cfg.model_metrics[p.model_ref] = e;
      // Persist ONLY the fresh delta into the EMBEDDED config file — never
      // JSON.stringify(cfg). `cfg` here is the layered RUNTIME config
      // (user override → project override →, when present, the regenerated
      // dynamic config with computed groups and the _dynamic marker), while
      // cfgPath is the shipped router-config.json. Writing the runtime cfg
      // here clobbers the embedded defaults with one machine's state: user
      // overrides and computed model_groups leak into the shipped file and
      // from there into every other layer source (final v1.6.0 review I1).
      let base: Record<string, unknown>;
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(rt.cfgPath, 'utf-8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('embedded config is not a JSON object');
        }
        base = raw as Record<string, unknown>;
      } catch (err) {
        // Unreadable/missing/corrupted/non-object embedded file — REFUSE to
        // write. Persisting a delta-only stub ({ model_metrics: { … } } and
        // nothing else) would replace the shipped defaults (providers,
        // model_groups, exclude, …) with an empty base layer and break every
        // future load() on this install (roborev reviews of 7b58045 and
        // e99265a). Losing one metrics update is strictly the lesser harm.
        routerLog(
          `[router] update_model_metrics: embedded config unusable, refusing to write to avoid clobbering: ${err instanceof Error ? err.message : textOf(err)}`
        );
        return syncResult({
          content: [
            {
              type: 'text' as const,
              text: `Metrics for ${p.model_ref} were NOT persisted: the embedded router-config.json is unreadable or not a JSON object, and writing would clobber the shipped defaults.`,
            },
          ],
          details: { model_ref: p.model_ref, metrics: e },
        });
      }
      const metricsBase = (base.model_metrics ?? {}) as Record<string, unknown>;
      const existingEntry = (metricsBase[p.model_ref] ?? {}) as Record<string, unknown>;
      base.model_metrics = {
        ...metricsBase,
        [p.model_ref]: { ...existingEntry, ...e },
      };
      fs.writeFileSync(rt.cfgPath, JSON.stringify(base, null, 2));
      // Update metrics cache with new values from config
      const existingMetrics = metricsModule.getM(p.model_ref);
      if (existingMetrics) {
        Object.assign(existingMetrics, e, { last_updated: Date.now() });
      }
      return syncResult({
        content: [{ type: 'text', text: `Updated ${p.model_ref}: ${JSON.stringify(e)}` }],
        details: { model_ref: p.model_ref, metrics: e },
      });
    },
  });
}
