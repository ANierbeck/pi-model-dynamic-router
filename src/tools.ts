/**
 * pi tool registrations, extracted from index.ts (refactor plan
 * 2026-10-02, task 10): bulk_read, set_model_from_group, resolve_model_group,
 * update_model_metrics. Tool names, flags and schemas are byte-identical —
 * these are user-visible API surface (plan invariant). Note:
 * set_model_from_group remains the ONLY sanctioned pi.setModel() caller.
 * Pure code motion.
 */

import { executeBulkRead } from './bulk-read.ts';
import { routerLog } from './logger.ts';
import * as metricsModule from './metrics.ts';
import { splitRef } from './utils.ts';
import type { ExtensionContext, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import * as fs from 'node:fs';
import type { Config, Metrics } from './types.ts';
import type { Router } from './routing.ts';

/**
 * Dependencies createTools reads from index.ts's extension closure. Exposed as
 * live accessors (getters, plus setters for state the moved code writes), so
 * every read sees the CURRENT closure value — index.ts reassigns cfg/router/
 * managers on reload, and a captured copy would go stale.
 */
interface ToolDeps {
  activeGroup: string | null;
  readonly cfg: Config;
  readonly cfgPath: string;
  readonly fmtModel: (ref: string, i: number, sel: boolean) => string;
  readonly getM: (ref: string) => Metrics;
  readonly load: () => void;
  readonly pi: ExtensionAPI;
  readonly resolve: (name: string) => { selected: string; candidates: string[]; } | null;
  readonly router: Router;
}

export function createTools(rt: ToolDeps) {
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
    }) as any,
    async execute(
      _id: string,
      params: { question: string; paths: string[] },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ) {
      const result = await executeBulkRead(params, ctx, rt.cfg, routerLog);
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
      'Resolve a model group and immediately switch the current session to use the selected model. Combines resolve_model_group + model switch in one step.',
    parameters: Type.Object({ group: Type.String({ description: 'Model group name' }) }) as any,
    async execute(
      _id: string,
      params: { group: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ) {
      rt.load();
      const name = params.group.toLowerCase(),
        res = rt.resolve(name);
      if (!res)
        throw new Error(
          `No models for group "${params.group}". Available: ${Object.keys(rt.cfg.model_groups).join(', ')}`
        );
      for (const ref of res.candidates) {
        const { provider, modelId } = splitRef(ref);
        const model = ctx.modelRegistry.find(provider, modelId);
        if (model && (await rt.pi.setModel(model))) {
          rt.activeGroup = name;
          rt.router.setActiveGroup(name);  // Set active group in router for display
          rt.router.setCurModel(ref);      // Set current model in router for status line
          const m = rt.getM(ref);
          return {
            content: [
              {
                type: 'text',
                text: `${ref} (${name}, gdp:${m.gdpval}, tps:${Math.round(m.throughput_tps)})`,
              },
            ],
            details: { group: name, selected: ref, provider, modelId },
          };
        }
      }
      throw new Error(`No available model in "${name}". Tried: ${res.candidates.join(', ')}`);
    },
  });

  rt.pi.registerTool({
    name: 'resolve_model_group',
    label: 'Resolve Model Group',
    description:
      'Resolve a model group name (strategic, tactical, operational, scout, fallback) to a concrete provider/model. Use this when you need to select a model for a subagent or task and want the router to pick the best one.',
    parameters: Type.Object({
      group: Type.String({
        description:
          'Model group name: strategic, tactical, operational, scout, fallback, or any custom group',
      }),
    }) as any,
    async execute(_id: string, params: { group: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: ExtensionContext) {
      rt.load();
      const name = params.group.toLowerCase(),
        res = rt.resolve(name);
      if (!res)
        throw new Error(
          `Unknown or empty group "${params.group}". Available: ${Object.keys(rt.cfg.model_groups).join(', ')}`
        );
      const { provider, modelId } = splitRef(res.selected);
      const table = res.candidates.map((r, i) => rt.fmtModel(r, i, i === 0)).join('\n');
      return {
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
      };
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
    }) as any,
    async execute(_id: string, p: { model_ref: string; gdpval?: number; throughput_tps?: number; avg_latency_ms?: number }, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: ExtensionContext) {
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
      let base: Record<string, any>;
      try {
        const raw = JSON.parse(fs.readFileSync(rt.cfgPath, 'utf-8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('embedded config is not a JSON object');
        }
        base = raw;
      } catch (err) {
        // Unreadable/missing/corrupted/non-object embedded file — REFUSE to
        // write. Persisting a delta-only stub ({ model_metrics: { … } } and
        // nothing else) would replace the shipped defaults (providers,
        // model_groups, exclude, …) with an empty base layer and break every
        // future load() on this install (roborev reviews of 7b58045 and
        // e99265a). Losing one metrics update is strictly the lesser harm.
        routerLog(
          `[router] update_model_metrics: embedded config unusable, refusing to write to avoid clobbering: ${err}`
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `Metrics for ${p.model_ref} were NOT persisted: the embedded router-config.json is unreadable or not a JSON object, and writing would clobber the shipped defaults.`,
            },
          ],
          details: { model_ref: p.model_ref, metrics: e },
        };
      }
      const existingEntry = base.model_metrics?.[p.model_ref] ?? {};
      base.model_metrics = {
        ...(base.model_metrics ?? {}),
        [p.model_ref]: { ...existingEntry, ...e },
      };
      fs.writeFileSync(rt.cfgPath, JSON.stringify(base, null, 2));
      // Update metrics cache with new values from config
      const existingMetrics = metricsModule.getM(p.model_ref);
      if (existingMetrics) {
        Object.assign(existingMetrics, e, { last_updated: Date.now() });
      }
      return {
        content: [{ type: 'text', text: `Updated ${p.model_ref}: ${JSON.stringify(e)}` }],
        details: { model_ref: p.model_ref, metrics: e },
      };
    },
  });
}
