// /router config — display (Phase 1), exclude/unexclude (Phase 2) and the
// compaction stub, driven through the real registered /router handler
// (plan 2026-10-06-router-config-command.md).
//
// Isolation: the user layer lives in a temp PI_CODING_AGENT_DIR, the shipped
// layer in a temp extDir (never the repo's router-config.json), the project
// layer in a temp cwd. The real ~/.pi is never touched.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCommands } from '../src/commands.ts';
import { loadLayeredConfig } from '../src/config-loader.ts';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Cache, Config } from '../src/types.ts';

const REGISTRY_REFS = ['shipped-prov/a', 'shipped-prov/b', 'user-prov/big', 'user-prov/small', 'proj/z', 'ok/m'];

let extDir: string;
let agentDir: string;
let cwd: string;
let userFile: string;
let prevAgentDir: string | undefined;

function writeShipped(extra: Record<string, unknown> = {}): void {
  const base = {
    model_groups: {
      trivial: { description: 'Trivial', method: 'min_cost_if_all_priced', max_cost: 0, min_gdpval: 0, fallback_groups: [] },
    },
    providers: {},
    model_metrics: {},
    gdpval_builtin: {},
    ...extra,
  };
  fs.writeFileSync(path.join(extDir, 'router-config.json'), JSON.stringify(base));
}

function makeRegistry(refs: string[]) {
  const all = refs.map((r) => {
    const [provider, ...rest] = r.split('/');
    return { provider, id: rest.join('/'), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  });
  return {
    find: (provider: string, id: string) => all.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => all,
    getRegisteredProviderIds: () => [...new Set(all.map((m) => m.provider))],
    hasConfiguredAuth: () => true,
    runtime: { hasConfiguredAuth: () => true },
  };
}

/**
 * Registers /router through createCommands against a minimal rt whose load()
 * mirrors index.ts: re-read the layered config, rebuild the router.
 */
function setup(refs: string[] = REGISTRY_REFS) {
  const cache: Cache = {
    available_models: [], gdpval_scores: {}, model_score_cache: {}, openrouter_pricing: {},
    usage_log: [], benchmarks: {}, budget_cache: {}, gdpval_scraped: true,
    lastScanTimestamp: Date.now(), models_cached: '',
  } as any;
  let cfg!: Config;
  let router!: Router;
  const load = vi.fn(() => {
    cfg = loadLayeredConfig(extDir, cwd).config;
    router = new Router(cfg, cache, new Map());
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.setModelMap({}, []);
  });
  let handler!: (args: string, ctx: any) => Promise<void>;
  let completions!: (prefix: string) => Array<{ value: string; label?: string }> | null;
  const rt: any = {
    get cfg() { return cfg; },
    get router() { return router; },
    cache,
    cfgPath: path.join(extDir, 'router-config.json'),
    load,
    sessionCtx: null,
    rateLimitManager: { getLimits: () => new Map(), listLimits: () => [] },
    allDiscoveredRefs: () => router.allDiscoveredRefs(),
    getTopModels: () => ({ models: [], total: 0 }),
    resolve: (name: string) => router.resolve(name),
    pi: {
      registerCommand: (_name: string, def: any) => {
        handler = def.handler;
        completions = def.getArgumentCompletions;
      },
    },
  };
  createCommands(rt);
  load();
  const notify = vi.fn();
  const ctx = { modelRegistry: makeRegistry(refs), ui: { notify } };
  const run = async (args: string): Promise<string> => {
    notify.mockClear();
    await handler(args, ctx);
    return notify.mock.calls.map((c) => String(c[0])).join('\n');
  };
  return { rt, run, completions: (p: string) => completions(p), load };
}

beforeEach(() => {
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cfgcmd-ext-'));
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cfgcmd-agent-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cfgcmd-cwd-'));
  userFile = path.join(agentDir, 'router-config.user.json');
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
});

describe('/router config — display', () => {
  beforeEach(() => {
    writeShipped({ exclude: { models: ['shipped-prov/*'] } });
    fs.writeFileSync(userFile, JSON.stringify({ exclude: { models: ['user-prov/big'] } }));
    fs.mkdirSync(path.join(cwd, '.pi'));
    fs.writeFileSync(path.join(cwd, '.pi', 'router-config.json'), JSON.stringify({ exclude: { models: ['proj/*'] } }));
  });

  it('lists each config source with its origin and path', async () => {
    const out = await setup().run('config');
    expect(out).toContain(`shipped  ${path.join(extDir, 'router-config.json')}`);
    expect(out).toContain(`user     ${userFile}`);
    expect(out).toContain(`project  ${path.join(cwd, '.pi', 'router-config.json')}`);
  });

  it('marks every effective exclude rule with its origin and the discovered models it matches', async () => {
    const out = await setup().run('config');
    expect(out).toContain('[shipped] models: shipped-prov/*  → matches 2 discovered model(s)');
    expect(out).toContain('[user]    models: user-prov/big  → matches 1 discovered model(s)');
    expect(out).toContain('[project] models: proj/*  → matches 1 discovered model(s)');
  });

  it('counts matches against the raw inventory even for rules already in effect', async () => {
    // allDiscoveredRefs() is post-exclude; a rule that is live would show 0
    // matches if the count were taken from it.
    const { run, rt } = setup();
    await run('config');
    expect(rt.router.allDiscoveredRefs()).not.toContain('shipped-prov/a');
    const out = await run('config');
    expect(out).toContain('shipped-prov/*  → matches 2 discovered model(s)');
  });

  it('shows absent layers as not present and unusable ones with their error', async () => {
    fs.rmSync(path.join(cwd, '.pi'), { recursive: true });
    fs.writeFileSync(userFile, '{ corrupt');
    const out = await setup().run('config');
    expect(out).toContain(`project  ${path.join(cwd, '.pi', 'router-config.json')} (not present)`);
    expect(out).toMatch(/user {5}.*router-config\.user\.json.*\(unusable: /);
  });

  it('states that compaction is not implemented yet', async () => {
    expect(await setup().run('config')).toContain('compaction: not implemented yet (Phase 5b)');
  });

  it('prints usage hints and the shipped/project un-exclude limitation', async () => {
    const out = await setup().run('config');
    expect(out).toContain('/router config exclude <ref|glob>');
    expect(out).toContain('/router config unexclude <ref|glob>');
    expect(out).toContain('Shipped and project entries cannot be removed with unexclude');
  });

  it('answers "config compaction on|off" with the Phase 5b stub and writes nothing', async () => {
    const before = fs.readFileSync(userFile, 'utf-8');
    const { run } = setup();
    expect(await run('config compaction on')).toContain('not implemented yet (Phase 5b)');
    expect(await run('config compaction off')).toContain('not implemented yet (Phase 5b)');
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(before);
  });

  it('does not fall through to the status overview', async () => {
    expect(await setup().run('config')).not.toContain('Model Router');
  });
});

describe('/router config — autocomplete', () => {
  it('offers the config rows under the config prefix', () => {
    writeShipped();
    const rows = setup().completions('config');
    expect(rows!.map((r) => r.label ?? r.value)).toEqual([
      'config',
      'config exclude <ref>',
      'config unexclude <ref>',
      'config compaction on|off',
    ]);
  });

  it('lists config in the unfiltered completions', () => {
    writeShipped();
    expect(setup().completions('')!.map((r) => r.value)).toContain('config');
  });
});
