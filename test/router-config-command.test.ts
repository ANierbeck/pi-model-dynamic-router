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
      // roundrobin = no price/score gates, so unscored fixture models stay candidates.
      trivial: { description: 'Trivial', method: 'roundrobin', fallback_groups: [] },
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
    router.setSessionCtx(rt.sessionCtx);
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
    sessionCtx: null as any,
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
  const notify = vi.fn();
  const ctx = { modelRegistry: makeRegistry(refs), ui: { notify } };
  rt.sessionCtx = ctx; // the running session; the handler restores it after every call
  load();
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

describe('/router config exclude', () => {
  const SHIPPED_PATH = () => path.join(extDir, 'router-config.json');
  const candidates = (rt: any) => rt.resolve('trivial')?.candidates ?? [];

  beforeEach(() => {
    writeShipped();
  });

  it('applies live: rt.cfg.exclude gains the pattern and the next resolve skips the matching model', async () => {
    const { rt, run } = setup(['aprov/m1:free', 'bprov/m2:free']);
    expect(candidates(rt)).toContain('aprov/m1:free');

    await run('config exclude aprov/*');

    expect(rt.cfg.exclude.models).toContain('aprov/*');
    expect(candidates(rt)).not.toContain('aprov/m1:free');
    expect(candidates(rt)).toContain('bprov/m2:free');
  });

  it('persists the pattern to the user file and keeps every key it already had', async () => {
    fs.writeFileSync(userFile, JSON.stringify({ log_level: 'debug', exclude: { providers: ['p'], models: ['old/*'] } }));
    await setup(['aprov/m1:free']).run('config exclude aprov/*');

    const after = JSON.parse(fs.readFileSync(userFile, 'utf-8'));
    expect(after.log_level).toBe('debug');
    expect(after.exclude.providers).toEqual(['p']);
    expect(after.exclude.models).toEqual(['old/*', 'aprov/*']);
  });

  it('leaves the shipped config byte-identical and writes no project config', async () => {
    const before = fs.readFileSync(SHIPPED_PATH());
    await setup(['aprov/m1:free']).run('config exclude aprov/*');
    expect(JSON.parse(fs.readFileSync(userFile, 'utf-8')).exclude.models).toEqual(['aprov/*']);
    expect(fs.readFileSync(SHIPPED_PATH()).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.pi'))).toBe(false);
  });

  it('reports the match count and the scan-cycle note', async () => {
    const out = await setup(['aprov/m1:free', 'aprov/m2:free', 'bprov/m3:free']).run('config exclude aprov/*');
    expect(out).toContain('matches 2 discovered model(s)');
    expect(out).toContain('takes full effect at the next scan cycle for persisted group lists');
  });

  it('rejects an implausible pattern without writing anything', async () => {
    const out = await setup().run('config exclude has space');
    expect(out).toMatch(/not a model ref or glob/);
    expect(fs.existsSync(userFile)).toBe(false);
  });

  it('answers a missing pattern with the usage hint', async () => {
    const out = await setup().run('config exclude');
    expect(out).toContain('Missing pattern');
    expect(out).toContain('/router config exclude <ref|glob>');
    expect(fs.existsSync(userFile)).toBe(false);
  });

  it('refuses to write over a corrupt user file and surfaces the error', async () => {
    fs.writeFileSync(userFile, '{ corrupt');
    const { rt, run } = setup(['aprov/m1:free']);
    const out = await run('config exclude aprov/*');
    expect(out).toMatch(/Not written/);
    expect(fs.readFileSync(userFile, 'utf-8')).toBe('{ corrupt');
    expect(rt.cfg.exclude?.models ?? []).not.toContain('aprov/*');
  });

  it('does not duplicate a pattern the user layer already has', async () => {
    fs.writeFileSync(userFile, JSON.stringify({ exclude: { models: ['aprov/*'] } }));
    const out = await setup(['aprov/m1:free']).run('config exclude aprov/*');
    expect(out).toMatch(/already/);
    expect(JSON.parse(fs.readFileSync(userFile, 'utf-8')).exclude.models).toEqual(['aprov/*']);
  });
});

describe('/router config unexclude', () => {
  beforeEach(() => {
    writeShipped({ exclude: { models: ['shipped-prov/*'] } });
  });

  it('removes a user-layer entry, persists it, keeps other keys and re-admits the model', async () => {
    fs.writeFileSync(userFile, JSON.stringify({ log_level: 'debug', exclude: { models: ['aprov/*', 'keep/*'] } }));
    const { rt, run } = setup(['aprov/m1:free', 'bprov/m2:free']);
    expect(rt.resolve('trivial')!.candidates).not.toContain('aprov/m1:free');

    const out = await run('config unexclude aprov/*');

    expect(out).toContain('takes full effect at the next scan cycle for persisted group lists');
    const after = JSON.parse(fs.readFileSync(userFile, 'utf-8'));
    expect(after.log_level).toBe('debug');
    expect(after.exclude.models).toEqual(['keep/*']);
    expect(rt.cfg.exclude.models).not.toContain('aprov/*');
    expect(rt.resolve('trivial')!.candidates).toContain('aprov/m1:free');
  });

  it('refuses a shipped entry with the documented answer and leaves the user file alone', async () => {
    fs.writeFileSync(userFile, JSON.stringify({ exclude: { models: ['other/*'] } }));
    const before = fs.readFileSync(userFile, 'utf-8');
    const out = await setup().run('config unexclude shipped-prov/*');
    expect(out).toContain(
      '"shipped-prov/*" is part of the shipped defaults — removable only in that layer (shipped defaults empty in the ADR-0025 B3 round)'
    );
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(before);
  });

  it('refuses a project entry naming the project layer', async () => {
    fs.mkdirSync(path.join(cwd, '.pi'));
    fs.writeFileSync(path.join(cwd, '.pi', 'router-config.json'), JSON.stringify({ exclude: { models: ['proj/*'] } }));
    const out = await setup().run('config unexclude proj/*');
    expect(out).toContain('"proj/*" is part of the project defaults — removable only in that layer');
  });

  it('says so when a removed user entry is still excluded by another layer', async () => {
    fs.writeFileSync(userFile, JSON.stringify({ exclude: { models: ['shipped-prov/*'] } }));
    const { rt, run } = setup();
    const out = await run('config unexclude shipped-prov/*');
    expect(out).toMatch(/still excluded by the shipped layer/);
    expect(JSON.parse(fs.readFileSync(userFile, 'utf-8')).exclude.models).toEqual([]);
    expect(rt.cfg.exclude.models).toContain('shipped-prov/*');
  });

  it('answers honestly when the pattern is in no layer', async () => {
    const out = await setup().run('config unexclude nowhere/*');
    expect(out).toContain('"nowhere/*" is not in any exclude list');
    expect(fs.existsSync(userFile)).toBe(false);
  });

  it('refuses to rewrite a corrupt user file', async () => {
    fs.writeFileSync(userFile, '{ corrupt');
    const out = await setup().run('config unexclude aprov/*');
    expect(out).toMatch(/Not written|unreadable|not in any/);
    expect(fs.readFileSync(userFile, 'utf-8')).toBe('{ corrupt');
  });

  it('mentions the layer whose provider rule still covers a removed user entry (review Minor 2)', async () => {
    writeShipped({ exclude: { providers: ['shipped-prov'] } });
    fs.writeFileSync(userFile, JSON.stringify({ exclude: { models: ['shipped-prov/*'] } }));
    const out = await setup().run('config unexclude shipped-prov/*');
    expect(out).toMatch(/still excluded by the shipped layer/);
    expect(JSON.parse(fs.readFileSync(userFile, 'utf-8')).exclude.models).toEqual([]);
  });

  it('names the covering layer when provider rules exclude the pattern but no models list does (review Minor 2)', async () => {
    writeShipped({ exclude: { providers: ['shipped-prov'] } });
    const out = await setup().run('config unexclude shipped-prov/*');
    expect(out).toMatch(/excluded by the shipped layer/);
    expect(out).not.toMatch(/not in any exclude list/);
    expect(fs.existsSync(userFile)).toBe(false);
  });
});
