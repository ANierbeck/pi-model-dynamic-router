// Orchestrator wiring of the explicit HINT (group and model) and of the
// classifier call, driven through the REAL StreamOrchestrator.groupStream.
//
// Mutation triage, nightly R4 (2026-11-04, run 41817385588, main @ fde54f8):
// 272 of the 663 undetected mutants of src/stream-orchestrator.ts sit in
// groupStream, and the explicit-HINT branches (`HINT: <group>`, `HINT: <model>`)
// were almost entirely NoCoverage — the selection a user triggers every time they
// pin a model had no test that drove it. The classifier itself is pinned
// elsewhere (hint-classification, category-taxonomy-v2); this file pins what the
// orchestrator DOES with a classification: which candidates it hands to
// driveStream, in which order, under which label and start group.
//
// driveStream is spied (its cascade is pinned in consolidated-stream-error-pins);
// every assertion is on what groupStream passes to it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamOrchestrator } from '../src/stream-orchestrator.ts';
import { toolFollowUpMessages } from './helpers/stream-fixtures.ts';
import { routerLog, appendRawLog, warnLog } from '../src/logger.ts';

vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return {
    ...actual,
    appendRawLog: vi.fn(),
    routerLog: vi.fn(),
    warnLog: vi.fn(),
    errorLog: vi.fn(),
  };
});

type Resolution = { candidates: string[]; selected: string };

interface Opts {
  groups?: Record<string, any>;
  resolvable?: Record<string, Resolution>;
  classification: any;
  discovered?: string[];
  gdp?: Record<string, number>;
  /** refs the registry knows (find) */
  known?: string[];
  /** refs getAvailable() lists */
  available?: string[];
  /** providers that have an API key (PROVIDER_MAP providers need one) */
  keyed?: string[];
  noRegistry?: boolean;
  topModels?: Record<string, string[]>;
  escalation?: string;
  cfgExtra?: Record<string, any>;
  cache?: Record<string, any>;
  lastDynamicModel?: string;
  lastCategory?: string;
  limited?: string[];
  compaction?: boolean;
  /** Real context window per ref, for the compaction-continuity decision. */
  window?: Record<string, number>;
  hintDirect?: boolean;
  messages?: any[];
  /** what extractLastUserPrompt returns; pass undefined explicitly for "no prompt" */
  prompt?: string | undefined;
}

const DEFAULT_GROUPS = {
  dynamic: { method: 'dynamic' },
  planning: { method: 'best', fallback_groups: ['standard'] },
  standard: { method: 'best', fallback_groups: ['simple'] },
  code_complex: { method: 'best' },
  simple: { method: 'best' },
};

function world(o: Opts) {
  const groups = o.groups ?? DEFAULT_GROUPS;
  const known = new Set(o.known ?? []);
  const registry = o.noRegistry
    ? undefined
    : {
        find: vi.fn((p: string, id: string) =>
          known.has(`${p}/${id}`) ? { provider: p, id } : undefined
        ),
        getAvailable: vi.fn(() =>
          (o.available ?? []).map((r) => ({
            provider: r.split('/')[0],
            id: r.slice(r.indexOf('/') + 1),
          }))
        ),
        getApiKeyForProvider: vi.fn(async (p: string) =>
          (o.keyed ?? []).includes(p) ? 'key' : null
        ),
        runtime: { streamSimple: () => ({}), completeSimple: vi.fn(() => 'completed') },
      };
  const cleared: string[] = [];
  const classifyPrompt = vi.fn(async () => o.classification);
  const ctx: any = {
    cfg: { model_groups: groups, model_metrics: {}, providers: {}, ...(o.cfgExtra ?? {}) },
    cache: o.cache ?? {},
    router: {
      allDiscoveredRefs: () => o.discovered ?? [],
      getTopModels: (g: string) => ({ models: (o.topModels?.[g] ?? []).map((ref) => ({ ref })) }),
    },
    lastDynamicModel: o.lastDynamicModel ?? '',
    lastClassifiedCategory: o.lastCategory,
    escalation: { level: o.escalation ?? 'standard' },
    sessionCtx: registry ? { modelRegistry: registry } : undefined,
    resolve: (name: string) => {
      const r = o.resolvable?.[name];
      return r ? { candidates: [...r.candidates], selected: r.selected } : null;
    },
    extractLastUserPrompt: () => ('prompt' in o ? o.prompt : 'please do the thing'),
    extractLastAssistantSnippet: () => 'last assistant words',
    detectHintDirectly: vi.fn(() => (o.hintDirect ? { hintType: 'model' } : null)),
    isCompactionTurn: () => o.compaction === true,
    // Compaction continuity reads the last model's real window and the
    // context token estimate (TODO I5). Configurable per test via
    // o.window; a ref without a window entry is unknown (null).
    getModelContextWindow: (ref: string) => o.window?.[ref] ?? null,
    isLimited: (r: string) => (o.limited ?? []).includes(r),
    clearLimit: (r: string) => cleared.push(r),
    lookupGdp: (r: string) => o.gdp?.[r] ?? null,
    getGroupForCategory: (category: string) =>
      category === 'standard' ? 'standard' : 'code_complex',
    classifyPrompt,
  };
  const orch = new StreamOrchestrator(ctx);
  const drive = vi.spyOn(orch, 'driveStream').mockResolvedValue(undefined as never);
  const messages = o.messages ?? [{ role: 'user', content: 'please do the thing', timestamp: 1 }];
  const open = async () => {
    orch.groupStream(
      { provider: 'router', id: 'dynamic', api: 'openai-completions' } as any,
      { messages } as any,
      undefined
    );
    await vi.waitFor(() => expect(drive).toHaveBeenCalled());
    // driveStream(proxy, candidates, context, options, label, groupName, ...)
    const a = drive.mock.calls[0] as unknown as any[];
    return {
      candidates: a[1] as string[],
      label: a[4] as string | undefined,
      group: a[5] as string | undefined,
    };
  };
  return { ctx, cleared, classifyPrompt, drive, open, registry };
}

beforeEach(() => vi.clearAllMocks());

// ── HINT: <group> ─────────────────────────────────────────────────────────

describe('HINT: <group>', () => {
  const res = {
    planning: { candidates: ['claude-bridge/opus', 'mistral/glm'], selected: 'claude-bridge/opus' },
    standard: { candidates: ['mistral/glm', 'mistral/large'], selected: 'mistral/glm' },
    simple: { candidates: ['openrouter/free', 'mistral/large'], selected: 'openrouter/free' },
  };

  it('hands the group plus its fallback groups (deduplicated, in order) to driveStream, labelled and grouped', async () => {
    const w = world({
      classification: { hintType: 'group', hintTarget: 'planning' },
      resolvable: res,
    });
    const d = await w.open();

    // planning's own candidates first; then standard's (minus the duplicate glm), NOT simple's:
    // fallback_groups are one level deep (standard's own chain is not followed).
    expect(d.candidates).toEqual(['claude-bridge/opus', 'mistral/glm', 'mistral/large']);
    expect(d.label).toBe('HINT: planning → claude-bridge/opus');
    expect(d.group).toBe('planning');
    expect(w.ctx.lastDynamicModel).toBe('claude-bridge/opus');
  });

  it('skips a fallback group that does not resolve and keeps the rest', async () => {
    const w = world({
      groups: {
        ...DEFAULT_GROUPS,
        planning: { method: 'best', fallback_groups: ['gone', 'standard'] },
      },
      classification: { hintType: 'group', hintTarget: 'planning' },
      resolvable: res,
    });
    const d = await w.open();
    expect(d.candidates).toEqual(['claude-bridge/opus', 'mistral/glm', 'mistral/large']);
  });

  it('a group without fallback_groups uses only its own candidates', async () => {
    const w = world({
      classification: { hintType: 'group', hintTarget: 'simple' },
      resolvable: res,
    });
    // `simple` has no fallback_groups in DEFAULT_GROUPS
    const d = await w.open();
    expect(d.candidates).toEqual(['openrouter/free', 'mistral/large']);
    expect(d.group).toBe('simple');
  });

  it('an unresolvable group falls through to normal classification', async () => {
    const w = world({
      classification: { hintType: 'group', hintTarget: 'nonexistent', category: 'standard' },
      resolvable: res,
    });
    const d = await w.open();
    expect(d.label).toBe('standard → standard');
    expect(d.group).toBe('standard');
    expect(routerLog).toHaveBeenCalledWith(
      expect.stringContaining('HINT group not found: nonexistent')
    );
  });

  it('a HINT that names the dynamic group itself falls through and says so', async () => {
    const w = world({
      classification: { hintType: 'group', hintTarget: 'dynamic', category: 'standard' },
      resolvable: res,
    });
    const d = await w.open();
    expect(d.label).toBe('standard → standard');
    expect(routerLog).toHaveBeenCalledWith(
      expect.stringContaining('HINT targets the dynamic group itself')
    );
    expect(routerLog).not.toHaveBeenCalledWith(expect.stringContaining('HINT group not found'));
  });
});

// ── HINT: <model> ─────────────────────────────────────────────────────────

describe('HINT: <model> — matching', () => {
  const base = { keyed: ['mistral', 'openrouter'] };

  it('an exact ref in the discovered pool is routed with the MHINT label (never "HINT:")', async () => {
    const w = world({
      ...base,
      classification: { hintType: 'model', hintTarget: 'claude-bridge/claude-opus-5-5' },
      discovered: ['claude-bridge/claude-opus-5-5', 'mistral/zai-glm-5-3'],
      known: ['claude-bridge/claude-opus-5-5'],
      gdp: { 'claude-bridge/claude-opus-5-5': 1900 },
    });
    const d = await w.open();
    expect(d.candidates[0]).toBe('claude-bridge/claude-opus-5-5');
    expect(d.label).toBe('MHINT: claude-bridge/claude-opus-5-5');
    expect(d.label).not.toMatch(/^HINT/);
    expect(w.ctx.lastDynamicModel).toBe('claude-bridge/claude-opus-5-5');
  });

  it('remembers the run: the pinned model drives it, its score band is the group (tool follow-up reads both)', async () => {
    const w = world({
      ...base,
      classification: { hintType: 'model', hintTarget: 'claude-bridge/claude-opus-5-5' },
      discovered: ['claude-bridge/claude-opus-5-5'],
      known: ['claude-bridge/claude-opus-5-5'],
      gdp: { 'claude-bridge/claude-opus-5-5': 1900 },
    });
    await w.open();
    expect(w.ctx.runGroup).toBe('planning');
    expect(w.ctx.runDriver).toBe('claude-bridge/claude-opus-5-5');
  });

  it('a bare name matches the model id under every provider that offers it', async () => {
    const w = world({
      ...base,
      classification: { hintType: 'model', hintTarget: 'zai-glm-5-3' },
      discovered: ['mistral/zai-glm-5-3', 'openrouter/z-ai/zai-glm-5-3', 'mistral/other'],
      known: ['mistral/zai-glm-5-3', 'openrouter/z-ai/zai-glm-5-3'],
    });
    const d = await w.open();
    expect(d.candidates).toEqual(
      expect.arrayContaining(['mistral/zai-glm-5-3', 'openrouter/z-ai/zai-glm-5-3'])
    );
    expect(d.candidates).not.toContain('mistral/other');
  });

  it('separator variants resolve to the real id ("zai-glm-5.3" → "zai-glm-5-3")', async () => {
    const w = world({
      ...base,
      classification: { hintType: 'model', hintTarget: 'zai-glm-5.3' },
      discovered: ['mistral/zai-glm-5-3'],
      known: ['mistral/zai-glm-5-3'],
    });
    const d = await w.open();
    expect(d.candidates[0]).toBe('mistral/zai-glm-5-3');
  });

  it('does not match a different version ("zai-glm-5-2" must not pick zai-glm-5-3)', async () => {
    const w = world({
      ...base,
      classification: { hintType: 'model', hintTarget: 'zai-glm-5-2', category: 'standard' },
      discovered: ['mistral/zai-glm-5-3'],
      known: ['mistral/zai-glm-5-3'],
      resolvable: { standard: { candidates: ['mistral/large'], selected: 'mistral/large' } },
    });
    const d = await w.open();
    expect(d.label).toBe('standard → standard');
    expect(routerLog).toHaveBeenCalledWith(
      expect.stringContaining('HINT model "zai-glm-5-2" not found')
    );
  });

  it('asks the registry per known provider when the discovered pool does not list the model, normalizing the name as a second try', async () => {
    const w = world({
      ...base,
      classification: { hintType: 'model', hintTarget: 'Special.Model' },
      discovered: ['mistral/other'],
      known: ['openrouter/special-model'],
    });
    const d = await w.open();
    expect(d.candidates[0]).toBe('openrouter/special-model');
    // exact name tried first, then the normalized one
    expect(w.registry!.find).toHaveBeenCalledWith('openrouter', 'Special.Model');
    expect(w.registry!.find).toHaveBeenCalledWith('openrouter', 'special-model');
  });

  it('does not ask the registry for the normalized name when it equals the exact one', async () => {
    const w = world({
      ...base,
      classification: { hintType: 'model', hintTarget: 'plain-name', category: 'standard' },
      discovered: ['mistral/other'],
      known: [],
      resolvable: { standard: { candidates: ['mistral/large'], selected: 'mistral/large' } },
    });
    await w.open();
    const calls = (w.registry!.find as any).mock.calls.filter((c: any[]) => c[1] === 'plain-name');
    // one lookup per provider, none doubled by a redundant normalized retry
    const perProvider = new Map<string, number>();
    for (const c of calls) perProvider.set(c[0], (perProvider.get(c[0]) ?? 0) + 1);
    expect([...perProvider.values()].every((n) => n === 1)).toBe(true);
  });

  it("falls back to a scan of every group's top models when neither pool nor registry knows the name", async () => {
    const w = world({
      ...base,
      classification: { hintType: 'model', hintTarget: 'hidden-model' },
      discovered: [],
      known: ['mistral/hidden-model'],
      topModels: { planning: ['mistral/hidden-model', 'mistral/x'], standard: ['mistral/y'] },
    });
    // registry does not list the provider to probe: remove it from the known set path by clearing find
    (w.registry!.find as any).mockImplementation(() => undefined);
    const d = await w.open();
    expect(d.candidates[0]).toBe('mistral/hidden-model');
    expect(routerLog).toHaveBeenCalledWith(
      expect.stringContaining('resolved "hidden-model" to "mistral/hidden-model" via group scan')
    );
  });

  it('survives a group whose top-model lookup throws', async () => {
    const w = world({
      ...base,
      classification: { hintType: 'model', hintTarget: 'hidden-model' },
      discovered: [],
      topModels: { standard: ['mistral/hidden-model'] },
    });
    (w.registry!.find as any).mockImplementation(() => undefined);
    const real = w.ctx.router.getTopModels;
    w.ctx.router.getTopModels = (g: string) => {
      if (g === 'planning') throw new Error('boom');
      return real(g);
    };
    const d = await w.open();
    expect(d.candidates[0]).toBe('mistral/hidden-model');
  });

  it('an unknown name falls through to normal classification (no pin, no crash)', async () => {
    const w = world({
      ...base,
      classification: { hintType: 'model', hintTarget: 'does-not-exist', category: 'standard' },
      discovered: ['mistral/other'],
      resolvable: { standard: { candidates: ['mistral/large'], selected: 'mistral/large' } },
    });
    const d = await w.open();
    expect(d.label).toBe('standard → standard');
    expect(d.candidates).toEqual(['mistral/large']);
    expect(routerLog).not.toHaveBeenCalledWith(expect.stringContaining('via group scan'));
  });

  it('works without a session registry (discovered pool only)', async () => {
    const w = world({
      noRegistry: true,
      classification: { hintType: 'model', hintTarget: 'claude-bridge/opus' },
      discovered: ['claude-bridge/opus'],
    });
    const d = await w.open();
    // without a registry no ref can be proven usable, but a unique match is still the only candidate
    expect(d.candidates).toEqual(['claude-bridge/opus']);
  });
});

describe('HINT: <model> — ordering, limits and the fallback tail', () => {
  const key = { keyed: ['mistral', 'openrouter'] };

  it('usable providers first, each tier by gdpval; unusable refs stay as last resort', async () => {
    const w = world({
      keyed: ['mistral'], // openrouter has no key → unusable
      classification: { hintType: 'model', hintTarget: 'shared-model' },
      discovered: ['openrouter/shared-model', 'mistral/shared-model', 'claude-bridge/shared-model'],
      known: ['openrouter/shared-model', 'mistral/shared-model', 'claude-bridge/shared-model'],
      gdp: {
        'openrouter/shared-model': 900,
        'mistral/shared-model': 500,
        'claude-bridge/shared-model': 700,
      },
    });
    const d = await w.open();
    // usable: claude-bridge (no PROVIDER_MAP entry → carries its own auth) 700, mistral 500; unusable: openrouter 900
    expect(d.candidates.slice(0, 3)).toEqual([
      'claude-bridge/shared-model',
      'mistral/shared-model',
      'openrouter/shared-model',
    ]);
    expect(routerLog).toHaveBeenCalledWith(
      expect.stringContaining(
        'skipping unusable refs (no handler/credentials): openrouter/shared-model'
      )
    );
  });

  it('a fully qualified hint that matches and is usable goes first even against a higher gdpval sibling', async () => {
    const w = world({
      ...key,
      classification: { hintType: 'model', hintTarget: 'mistral/shared-model' },
      discovered: ['mistral/shared-model', 'claude-bridge/shared-model'],
      known: ['mistral/shared-model', 'claude-bridge/shared-model'],
      gdp: { 'mistral/shared-model': 100, 'claude-bridge/shared-model': 900 },
    });
    const d = await w.open();
    expect(d.candidates[0]).toBe('mistral/shared-model');
    // the same model under another provider stays a sibling candidate, exactly once
    expect(d.candidates.filter((r) => r === 'mistral/shared-model')).toHaveLength(1);
    expect(d.candidates).toContain('claude-bridge/shared-model');
  });

  it('a qualified hint whose ref is NOT usable does not jump the queue', async () => {
    const w = world({
      keyed: [], // mistral unusable
      classification: { hintType: 'model', hintTarget: 'mistral/shared-model' },
      discovered: ['mistral/shared-model', 'claude-bridge/shared-model'],
      known: ['mistral/shared-model', 'claude-bridge/shared-model'],
      gdp: { 'mistral/shared-model': 100, 'claude-bridge/shared-model': 900 },
    });
    const d = await w.open();
    expect(d.candidates[0]).toBe('claude-bridge/shared-model');
  });

  it('an explicit hint clears cooldowns on its candidates; an auto-derived one does not', async () => {
    const explicit = world({
      ...key,
      classification: { hintType: 'model', hintTarget: 'mistral/m', origin: 'user' },
      discovered: ['mistral/m'],
      known: ['mistral/m'],
    });
    await explicit.open();
    expect(explicit.cleared).toContain('mistral/m');

    const auto = world({
      ...key,
      classification: { hintType: 'model', hintTarget: 'mistral/m', origin: 'auto' },
      discovered: ['mistral/m'],
      known: ['mistral/m'],
    });
    await auto.open();
    expect(auto.cleared).toEqual([]);

    const legacy = world({
      ...key,
      classification: { hintType: 'model', hintTarget: 'mistral/m' }, // no origin → treated as explicit
      discovered: ['mistral/m'],
      known: ['mistral/m'],
    });
    await legacy.open();
    expect(legacy.cleared).toContain('mistral/m');
  });

  it('appends at most five usable fallback models after the hinted ones, best gdpval first, skipping blocked, excluded and duplicates', async () => {
    // deliberately NOT in gdpval order: the sort is what puts a..e first
    const available = [
      'mistral/f',
      'mistral/m',
      'mistral/c',
      'mistral/blocked',
      'mistral/e',
      'mistral/excluded',
      'mistral/a',
      'openrouter/nokey',
      'mistral/d',
      'mistral/b',
    ];
    const gdp: Record<string, number> = {
      'mistral/a': 60,
      'mistral/b': 50,
      'mistral/c': 40,
      'mistral/d': 30,
      'mistral/e': 20,
      'mistral/f': 10,
      'mistral/blocked': 999,
      'mistral/excluded': 998,
      'openrouter/nokey': 997,
      'mistral/m': 5,
    };
    const w = world({
      keyed: ['mistral'],
      classification: { hintType: 'model', hintTarget: 'mistral/m' },
      discovered: ['mistral/m'],
      known: available,
      available,
      gdp,
      cfgExtra: { exclude: { models: ['mistral/excluded'] } },
      cache: { model_blocklist: { 'mistral/blocked': { last_seen: Date.now() } } },
    });
    const d = await w.open();
    expect(d.candidates).toEqual([
      'mistral/m',
      'mistral/a',
      'mistral/b',
      'mistral/c',
      'mistral/d',
      'mistral/e',
    ]);
    expect(routerLog).toHaveBeenCalledWith(
      expect.stringContaining(
        'HINT fallback candidates: mistral/a, mistral/b, mistral/c, mistral/d, mistral/e'
      )
    );
  });

  it('models without a known gdpval sort last in the fallback tail (treated as 0)', async () => {
    const available = ['mistral/unknown', 'mistral/m', 'mistral/known']; // unknown listed first
    const w = world({
      keyed: ['mistral'],
      classification: { hintType: 'model', hintTarget: 'mistral/m' },
      discovered: ['mistral/m'],
      known: available,
      available,
      gdp: { 'mistral/known': 1 },
    });
    const d = await w.open();
    expect(d.candidates).toEqual(['mistral/m', 'mistral/known', 'mistral/unknown']);
  });

  it('adds no fallback tail (and no log line) when nothing else is usable', async () => {
    const w = world({
      keyed: ['mistral'],
      classification: { hintType: 'model', hintTarget: 'mistral/m' },
      discovered: ['mistral/m'],
      known: ['mistral/m'],
      available: ['mistral/m'],
    });
    const d = await w.open();
    expect(d.candidates).toEqual(['mistral/m']);
    expect(routerLog).not.toHaveBeenCalledWith(expect.stringContaining('HINT fallback candidates'));
  });

  it('without an exclude config nothing is filtered out of the tail', async () => {
    const available = ['mistral/m', 'mistral/other'];
    const w = world({
      keyed: ['mistral'],
      classification: { hintType: 'model', hintTarget: 'mistral/m' },
      discovered: ['mistral/m'],
      known: available,
      available,
    });
    const d = await w.open();
    expect(d.candidates).toEqual(['mistral/m', 'mistral/other']);
  });
});

describe("HINT: <model> — start group follows the hinted model's gdpval (D2)", () => {
  const start = async (gdpval: number | undefined) => {
    const w = world({
      keyed: ['mistral'],
      classification: { hintType: 'model', hintTarget: 'mistral/m' },
      discovered: ['mistral/m'],
      known: ['mistral/m'],
      gdp: gdpval === undefined ? {} : { 'mistral/m': gdpval },
    });
    return (await w.open()).group;
  };

  it('>= 700 → planning, 699 → code_complex', async () => {
    expect(await start(1900)).toBe('planning');
    expect(await start(700)).toBe('planning');
    expect(await start(699)).toBe('code_complex');
  });

  it('>= 300 → code_complex, 299 → simple, unknown → simple', async () => {
    expect(await start(300)).toBe('code_complex');
    expect(await start(299)).toBe('simple');
    expect(await start(undefined)).toBe('simple');
    expect(await start(0)).toBe('simple');
  });
});

// ── escalation and the normal path ───────────────────────────────────────

describe('after classification: escalation and target resolution', () => {
  const res = {
    standard: { candidates: ['mistral/glm', 'mistral/large'], selected: 'mistral/glm' },
    code_complex: { candidates: ['claude-bridge/sonnet'], selected: 'claude-bridge/sonnet' },
    planning: { candidates: ['claude-bridge/opus'], selected: 'claude-bridge/opus' },
    simple: { candidates: ['openrouter/free', 'mistral/large'], selected: 'openrouter/free' },
  };

  it('at the standard level the category picks the group', async () => {
    const w = world({ classification: { category: 'standard' }, resolvable: res });
    const d = await w.open();
    expect(d.label).toBe('standard → standard');
    expect(d.group).toBe('standard');
    expect(w.ctx.lastClassifiedCategory).toBe('standard');
    expect(w.ctx.lastDynamicModel).toBe('mistral/glm');
  });

  it('at the standard level a non-standard category still picks ITS group (not the literal level name)', async () => {
    const w = world({ classification: { category: 'code' }, resolvable: res });
    const d = await w.open();
    expect(d.group).toBe('code_complex');
    expect(d.label).toBe('code → code_complex');
    expect(routerLog).not.toHaveBeenCalledWith(expect.stringContaining('[escalation]'));
  });

  it('an escalated level overrides the category and is logged', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: res,
      escalation: 'planning',
    });
    const d = await w.open();
    expect(d.group).toBe('planning');
    expect(d.label).toBe('standard → planning');
    expect(routerLog).toHaveBeenCalledWith(
      expect.stringContaining('[escalation] Using escalated group: planning')
    );
  });

  it("the target group's fallback groups follow its own candidates, deduplicated, one level deep", async () => {
    const w = world({ classification: { category: 'standard' }, resolvable: res });
    const d = await w.open();
    // standard → fallback simple: its duplicate (mistral/large) is dropped
    expect(d.candidates).toEqual(['mistral/glm', 'mistral/large', 'openrouter/free']);
  });

  it('an unresolvable target group falls to simple and reports simple as the group', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: { simple: res.simple },
    });
    const d = await w.open();
    expect(d.group).toBe('simple');
    expect(d.candidates).toEqual(['openrouter/free', 'mistral/large']);
  });

  it('skips fallback groups that do not resolve', async () => {
    const w = world({
      groups: {
        ...DEFAULT_GROUPS,
        standard: { method: 'best', fallback_groups: ['gone', 'simple'] },
      },
      classification: { category: 'standard' },
      resolvable: res,
    });
    const d = await w.open();
    expect(d.candidates).toEqual(['mistral/glm', 'mistral/large', 'openrouter/free']);
  });

  it('a classification without a category (no hint) does not overwrite the remembered category', async () => {
    const w = world({
      classification: { hintType: 'group', hintTarget: 'planning' },
      resolvable: { planning: res.planning },
      lastCategory: 'design',
    });
    await w.open();
    expect(w.ctx.lastClassifiedCategory).toBe('design');
  });
});

// ── what the classifier is given ─────────────────────────────────────────

describe('classifier call wiring', () => {
  const res = { standard: { candidates: ['mistral/glm'], selected: 'mistral/glm' } };
  const opts = async (o: Partial<Opts> = {}) => {
    const w = world({ classification: { category: 'standard' }, resolvable: res, ...o });
    await w.open();
    return { w, args: w.classifyPrompt.mock.calls[0] as unknown as [string, any] };
  };

  it('passes the prompt and the conversation context', async () => {
    const { args } = await opts({
      lastCategory: 'design',
      lastDynamicModel: 'mistral/glm',
      limited: ['mistral/glm'],
      compaction: true,
    });
    expect(args[0]).toBe('please do the thing');
    expect(args[1].context).toMatchObject({
      lastAssistantSnippet: 'last assistant words',
      lastCategory: 'design',
      lastModel: 'mistral/glm',
      isCompaction: true,
      lastModelLimited: true,
    });
  });

  it('reports no last model (undefined, not "") and not limited when there is none', async () => {
    const { args } = await opts({});
    expect(args[1].context.lastModel).toBeUndefined();
    expect(args[1].context.lastModelLimited).toBe(false);
    expect(args[1].context.isCompaction).toBe(false);
  });

  it('a last model that is not limited is reported as not limited', async () => {
    const { args } = await opts({ lastDynamicModel: 'mistral/glm', limited: [] });
    expect(args[1].context.lastModelLimited).toBe(false);
  });

  it('allowStaticFallback follows the :use-static suffix, allowCloudFallback only an explicit true', async () => {
    const plain = await opts({});
    expect(plain.args[1].allowStaticFallback).toBe(false);
    expect(plain.args[1].allowCloudFallback).toBe(false);

    const cloud = await opts({
      groups: {
        ...DEFAULT_GROUPS,
        dynamic: { method: 'dynamic', classifier_cloud_fallback: true },
      },
    });
    expect(cloud.args[1].allowCloudFallback).toBe(true);

    const truthyButNotTrue = await opts({
      groups: {
        ...DEFAULT_GROUPS,
        dynamic: { method: 'dynamic', classifier_cloud_fallback: 'yes' as any },
      },
    });
    expect(truthyButNotTrue.args[1].allowCloudFallback).toBe(false);
  });

  it('passes the pinned cloud model through verbatim (provider/id form, not stripped)', async () => {
    const { args } = await opts({
      groups: {
        ...DEFAULT_GROUPS,
        dynamic: { method: 'dynamic', classifier_cloud_model: 'mistral/mistral-large-4' },
      },
    });
    expect(args[1].pinnedCloudModel).toBe('mistral/mistral-large-4');
    const none = await opts({});
    expect('pinnedCloudModel' in none.args[1]).toBe(false);
  });

  it('findModel splits provider/id at the FIRST slash and asks the session registry', async () => {
    const { w, args } = await opts({ known: ['openrouter/z-ai/glm'] });
    const model = args[1].findModel('openrouter/z-ai/glm');
    expect(w.registry!.find).toHaveBeenCalledWith('openrouter', 'z-ai/glm');
    expect(model).toEqual({ provider: 'openrouter', id: 'z-ai/glm' });
    expect(args[1].findModel('no-slash')).toBeUndefined();
  });

  it('findModel and completeSimple are inert without a registry', async () => {
    const { args } = await opts({ noRegistry: true });
    expect(args[1].findModel('a/b')).toBeUndefined();
    expect(args[1].completeSimple({}, {}, {})).toBeUndefined();
  });

  it("completeSimple goes through the registry's runtime with the same arguments", async () => {
    const { w, args } = await opts({});
    const m = { provider: 'x', id: 'y' };
    expect(args[1].completeSimple(m, { messages: [] }, { signal: 1 })).toBe('completed');
    expect(w.registry!.runtime.completeSimple).toHaveBeenCalledWith(
      m,
      { messages: [] },
      { signal: 1 }
    );
  });

  it('hasConfiguredAuth asks the registry when it can, and fails OPEN when the facade lacks the method', async () => {
    const withAuth = await opts({});
    (withAuth.w.registry as any).hasConfiguredAuth = vi.fn(() => false);
    expect(withAuth.args[1].hasConfiguredAuth({ provider: 'x' })).toBe(false);
    (withAuth.w.registry as any).hasConfiguredAuth = vi.fn(() => 1);
    expect(withAuth.args[1].hasConfiguredAuth({ provider: 'x' })).toBe(true); // coerced to boolean

    const without = await opts({});
    expect(without.args[1].hasConfiguredAuth({ provider: 'x' })).toBe(true);
    const noReg = await opts({ noRegistry: true });
    expect(noReg.args[1].hasConfiguredAuth({ provider: 'x' })).toBe(true);
  });
});

// ── tool follow-up shortcut ──────────────────────────────────────────────

describe('tool follow-up step', () => {
  const messages = toolFollowUpMessages();
  const simple = {
    simple: { candidates: ['openrouter/free', 'mistral/large'], selected: 'openrouter/free' },
  };

  it('puts the last model first, then the simple pool without it, and skips classification', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: simple,
      messages,
      lastDynamicModel: 'mistral/large',
    });
    const d = await w.open();
    expect(d.candidates).toEqual(['mistral/large', 'openrouter/free']);
    expect(d.group).toBe('simple');
    expect(w.classifyPrompt).not.toHaveBeenCalled();
  });

  it('asks the hint detector about the extracted prompt (empty string when there is none)', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: simple,
      messages,
      lastDynamicModel: 'mistral/large',
    });
    await w.open();
    expect(w.ctx.detectHintDirectly).toHaveBeenCalledWith('please do the thing');

    const none = world({
      classification: { category: 'standard' },
      resolvable: simple,
      messages,
      lastDynamicModel: 'mistral/large',
      prompt: undefined,
    });
    await none.open();
    expect(none.ctx.detectHintDirectly).toHaveBeenCalledWith('');
  });

  it('an empty conversation is never a follow-up', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: { ...simple, standard: { candidates: ['mistral/glm'], selected: 'mistral/glm' } },
      messages: [],
      lastDynamicModel: 'mistral/large',
    });
    await w.open();
    expect(w.classifyPrompt).toHaveBeenCalled();
  });

  it('is not a follow-up without a remembered model', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: { ...simple, standard: { candidates: ['mistral/glm'], selected: 'mistral/glm' } },
      messages,
    });
    await w.open();
    expect(w.classifyPrompt).toHaveBeenCalled();
  });

  it('is not a follow-up when the prompt itself carries a HINT', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: { ...simple, standard: { candidates: ['mistral/glm'], selected: 'mistral/glm' } },
      messages,
      lastDynamicModel: 'mistral/large',
      hintDirect: true,
    });
    await w.open();
    expect(w.classifyPrompt).toHaveBeenCalled();
  });

  it('is not a follow-up after a plain user message', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: { ...simple, standard: { candidates: ['mistral/glm'], selected: 'mistral/glm' } },
      lastDynamicModel: 'mistral/large',
    });
    await w.open();
    expect(w.classifyPrompt).toHaveBeenCalled();
  });

  it('falls to the first non-dynamic group when simple does not resolve', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: {
        planning: { candidates: ['claude-bridge/opus'], selected: 'claude-bridge/opus' },
      },
      messages,
      lastDynamicModel: 'mistral/large',
    });
    const d = await w.open();
    expect(d.group).toBe('planning');
    expect(d.candidates).toEqual(['mistral/large', 'claude-bridge/opus']);
  });
});

// ── plain (non-dynamic) groups and :use-static ───────────────────────────

describe('group name parsing', () => {
  it('a :use-static suffix names the group and switches the static fallback on', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: { standard: { candidates: ['mistral/glm'], selected: 'mistral/glm' } },
    });
    w.ctx.cfg.model_groups.dynamic = { method: 'dynamic' };
    const orch = new StreamOrchestrator(w.ctx);
    const drive = vi.spyOn(orch, 'driveStream').mockResolvedValue(undefined as never);
    orch.groupStream(
      { provider: 'router', id: 'dynamic:use-static', api: 'x' } as any,
      { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] } as any,
      undefined
    );
    await vi.waitFor(() => expect(drive).toHaveBeenCalled());
    expect(w.classifyPrompt.mock.calls[0][1].allowStaticFallback).toBe(true);
  });

  it('a static group is driven directly with its candidates and its own name', async () => {
    const w = world({
      classification: {},
      resolvable: {
        standard: { candidates: ['mistral/glm', 'mistral/large'], selected: 'mistral/glm' },
      },
    });
    const orch = new StreamOrchestrator(w.ctx);
    const drive = vi.spyOn(orch, 'driveStream').mockResolvedValue(undefined as never);
    orch.groupStream(
      { provider: 'router', id: 'standard', api: 'x' } as any,
      { messages: [] } as any,
      undefined
    );
    const a = drive.mock.calls[0] as unknown as any[];
    expect(a[1]).toEqual(['mistral/glm', 'mistral/large']);
    expect(a[5]).toBe('standard');
    expect(w.classifyPrompt).not.toHaveBeenCalled();
  });

  it('a static group that cannot be resolved throws a named error', () => {
    const w = world({ classification: {}, resolvable: {} });
    const orch = new StreamOrchestrator(w.ctx);
    expect(() =>
      orch.groupStream(
        { provider: 'router', id: 'standard', api: 'x' } as any,
        { messages: [] } as any,
        undefined
      )
    ).toThrow('No available models for group "standard"');
  });

  it('a name that merely CONTAINS :use-static in the middle is not treated as the suffix', () => {
    const w = world({ classification: {}, resolvable: {} });
    const orch = new StreamOrchestrator(w.ctx);
    expect(() =>
      orch.groupStream(
        { provider: 'router', id: 'a:use-static-b', api: 'x' } as any,
        { messages: [] } as any,
        undefined
      )
    ).toThrow('No available models for group "a:use-static-b"');
  });
});

// ── gaps found by the first recheck of this file (R4, slice 1) ────────────

describe('classifier wiring — config shapes', () => {
  const res = { standard: { candidates: ['mistral/glm'], selected: 'mistral/glm' } };
  const named = (cfgDynamic?: any, id = 'auto') => {
    const groups: Record<string, any> = {
      standard: { method: 'best' },
      simple: { method: 'best' },
    };
    groups[id] = { method: 'dynamic' };
    if (cfgDynamic) groups.dynamic = cfgDynamic;
    return groups;
  };
  const run = async (o: Partial<Opts>, id: string) => {
    const w = world({ classification: { category: 'standard' }, resolvable: res, ...o });
    w.ctx.cfg.model_groups = o.groups ?? w.ctx.cfg.model_groups;
    const orch = new StreamOrchestrator(w.ctx);
    const drive = vi.spyOn(orch, 'driveStream').mockResolvedValue(undefined as never);
    orch.groupStream(
      { provider: 'router', id, api: 'x' } as any,
      { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] } as any,
      undefined
    );
    await vi.waitFor(() => expect(drive).toHaveBeenCalled());
    return { w, args: w.classifyPrompt.mock.calls[0] as unknown as [string, any] };
  };

  it('works when the dynamic group is not literally named "dynamic" (no config object to read)', async () => {
    const { args } = await run({ groups: named() }, 'auto');
    expect(args[1].allowCloudFallback).toBe(false);
    expect('pinnedCloudModel' in args[1]).toBe(false);
  });

  it("passes the user's local classifier pins (ollama/ prefix stripped)", async () => {
    const { args } = await run(
      {
        groups: named(
          {
            method: 'dynamic',
            classifier_model: 'ollama/gemma:2b',
            classifier_fallback: 'qwen:1b',
          },
          'auto'
        ),
      },
      'auto'
    );
    expect(args[1]).toMatchObject({ model: 'gemma:2b', fallbackModel: 'qwen:1b' });
  });

  it('an empty prompt reaches the classifier as an empty string', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: res,
      prompt: undefined,
    });
    await w.open();
    expect(w.classifyPrompt.mock.calls[0][0]).toBe('');
  });

  it('findModel stays undefined for a ref without a slash even when the registry would answer anything', async () => {
    const w = world({ classification: { category: 'standard' }, resolvable: res });
    (w.registry!.find as any).mockImplementation((p: string, id: string) => ({ provider: p, id }));
    await w.open();
    const opts = w.classifyPrompt.mock.calls[0][1];
    expect(opts.findModel('no-slash')).toBeUndefined();
    expect(opts.findModel('p/id')).toEqual({ provider: 'p', id: 'id' });
  });

  it('completeSimple is undefined (not a throw) when the runtime or the method is missing', async () => {
    const noRuntime = world({ classification: { category: 'standard' }, resolvable: res });
    delete (noRuntime.registry as any).runtime;
    await noRuntime.open();
    expect(noRuntime.classifyPrompt.mock.calls[0][1].completeSimple({}, {}, {})).toBeUndefined();

    const noMethod = world({ classification: { category: 'standard' }, resolvable: res });
    (noMethod.registry as any).runtime = {};
    await noMethod.open();
    expect(noMethod.classifyPrompt.mock.calls[0][1].completeSimple({}, {}, {})).toBeUndefined();
  });
});

describe('HINT edge cases', () => {
  it('a hint that names an unresolvable GROUP is not retried as a model of the same name', async () => {
    const w = world({
      keyed: ['mistral'],
      classification: { hintType: 'group', hintTarget: 'ghost', category: 'standard' },
      discovered: ['mistral/ghost'],
      known: ['mistral/ghost'],
      resolvable: { standard: { candidates: ['mistral/large'], selected: 'mistral/large' } },
    });
    const d = await w.open();
    expect(d.candidates).toEqual(['mistral/large']);
    expect(d.label).toBe('standard → standard');
  });

  it('a hinted group that resolves but is missing from the config still routes (no fallback chain)', async () => {
    const w = world({
      classification: { hintType: 'group', hintTarget: 'unlisted' },
      resolvable: { unlisted: { candidates: ['mistral/glm'], selected: 'mistral/glm' } },
    });
    const d = await w.open();
    expect(d.candidates).toEqual(['mistral/glm']);
    expect(d.group).toBe('unlisted');
  });

  it('a target group that resolves but is missing from the config still routes (no fallback chain)', async () => {
    const w = world({
      classification: { category: 'standard' },
      groups: { dynamic: { method: 'dynamic' }, simple: { method: 'best' } },
      resolvable: { standard: { candidates: ['mistral/glm'], selected: 'mistral/glm' } },
    });
    const d = await w.open();
    expect(d.candidates).toEqual(['mistral/glm']);
  });

  it('two fallback groups that share a candidate contribute it once (HINT group)', async () => {
    const w = world({
      groups: {
        ...DEFAULT_GROUPS,
        planning: { method: 'best', fallback_groups: ['standard', 'simple'] },
      },
      classification: { hintType: 'group', hintTarget: 'planning' },
      resolvable: {
        planning: { candidates: ['claude-bridge/opus'], selected: 'claude-bridge/opus' },
        standard: { candidates: ['mistral/glm', 'mistral/large'], selected: 'mistral/glm' },
        simple: { candidates: ['openrouter/free', 'mistral/large'], selected: 'openrouter/free' },
      },
    });
    const d = await w.open();
    expect(d.candidates).toEqual([
      'claude-bridge/opus',
      'mistral/glm',
      'mistral/large',
      'openrouter/free',
    ]);
  });

  it('two fallback groups that share a candidate contribute it once (normal routing)', async () => {
    const w = world({
      groups: {
        ...DEFAULT_GROUPS,
        standard: { method: 'best', fallback_groups: ['planning', 'simple'] },
      },
      classification: { category: 'standard' },
      resolvable: {
        standard: { candidates: ['mistral/glm'], selected: 'mistral/glm' },
        planning: {
          candidates: ['claude-bridge/opus', 'mistral/large'],
          selected: 'claude-bridge/opus',
        },
        simple: { candidates: ['openrouter/free', 'mistral/large'], selected: 'openrouter/free' },
      },
    });
    const d = await w.open();
    expect(d.candidates).toEqual([
      'mistral/glm',
      'claude-bridge/opus',
      'mistral/large',
      'openrouter/free',
    ]);
  });

  it('providers known only from the discovered pool or from cfg.providers are asked too', async () => {
    const w = world({
      keyed: [],
      cfgExtra: { providers: { custom: {} } },
      classification: { hintType: 'model', hintTarget: 'target' },
      discovered: ['fromdiscovery/other'],
      known: ['fromdiscovery/target', 'custom/target'],
    });
    const d = await w.open();
    expect(d.candidates).toEqual(expect.arrayContaining(['fromdiscovery/target', 'custom/target']));
  });

  it('a pool match skips the group scan entirely', async () => {
    const w = world({
      keyed: ['mistral'],
      classification: { hintType: 'model', hintTarget: 'target' },
      discovered: ['mistral/target'],
      known: ['mistral/target'],
      topModels: { standard: ['otherprov/target'] },
    });
    const d = await w.open();
    expect(d.candidates).toEqual(['mistral/target']);
  });
});

describe('decision lines (router.log)', () => {
  const lineOf = () => (appendRawLog as any).mock.calls.map((c: any[]) => String(c[0]));

  it('a normal routing decision logs a timestamp, the label, the selected ref and the prompt (80 chars, one line)', async () => {
    const long = 'first line\n' + 'x'.repeat(200);
    const w = world({
      classification: { category: 'standard' },
      resolvable: { standard: { candidates: ['mistral/glm'], selected: 'mistral/glm' } },
      prompt: long,
    });
    await w.open();
    expect(lineOf()).toHaveLength(1);
    const line = lineOf()[0];
    expect(line).toMatch(
      /^\d{4}-\d\d-\d\dT[\d:.]+Z {2}standard → standard {2}mistral\/glm {2}"first line x{69}"$/
    );
  });

  it('a group HINT logs without a selected-ref column; a model HINT logs MHINT with the first sibling', async () => {
    const g = world({
      classification: { hintType: 'group', hintTarget: 'planning' },
      resolvable: {
        planning: { candidates: ['claude-bridge/opus'], selected: 'claude-bridge/opus' },
      },
      prompt: 'pin a group',
    });
    await g.open();
    expect(lineOf()[0]).toMatch(/Z {2}HINT: planning → claude-bridge\/opus {2}"pin a group"$/);

    vi.clearAllMocks();
    const m = world({
      keyed: ['mistral'],
      classification: { hintType: 'model', hintTarget: 'mistral/m' },
      discovered: ['mistral/m'],
      known: ['mistral/m'],
      prompt: 'pin a model',
    });
    await m.open();
    expect(lineOf()[0]).toMatch(/Z {2}MHINT: mistral\/m {2}mistral\/m {2}"pin a model"$/);
  });

  it('HINT lines also cut the prompt at 80 characters and keep it on one line', async () => {
    const long = 'first line\n' + 'x'.repeat(200);
    const g = world({
      classification: { hintType: 'group', hintTarget: 'planning' },
      resolvable: {
        planning: { candidates: ['claude-bridge/opus'], selected: 'claude-bridge/opus' },
      },
      prompt: long,
    });
    await g.open();
    expect(lineOf()[0]).toMatch(/Z {2}HINT: planning → claude-bridge\/opus {2}"first line x{69}"$/);

    vi.clearAllMocks();
    const m = world({
      keyed: ['mistral'],
      classification: { hintType: 'model', hintTarget: 'mistral/m' },
      discovered: ['mistral/m'],
      known: ['mistral/m'],
      prompt: long,
    });
    await m.open();
    expect(lineOf()[0]).toMatch(/Z {2}MHINT: mistral\/m {2}mistral\/m {2}"first line x{69}"$/);
  });

  it('HINT lines without a prompt log an empty quoted string too', async () => {
    const g = world({
      classification: { hintType: 'group', hintTarget: 'planning' },
      resolvable: {
        planning: { candidates: ['claude-bridge/opus'], selected: 'claude-bridge/opus' },
      },
      prompt: undefined,
    });
    await g.open();
    expect(lineOf()[0]).toMatch(/Z {2}HINT: planning → claude-bridge\/opus {2}""$/);

    vi.clearAllMocks();
    const m = world({
      keyed: ['mistral'],
      classification: { hintType: 'model', hintTarget: 'mistral/m' },
      discovered: ['mistral/m'],
      known: ['mistral/m'],
      prompt: undefined,
    });
    await m.open();
    expect(lineOf()[0]).toMatch(/Z {2}MHINT: mistral\/m {2}mistral\/m {2}""$/);
  });

  it('a missing prompt logs as an empty quoted string', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: { standard: { candidates: ['mistral/glm'], selected: 'mistral/glm' } },
      prompt: undefined,
    });
    await w.open();
    expect(lineOf()[0]).toMatch(/ {2}""$/);
  });
});

describe('total failure', () => {
  it('when nothing resolves anywhere the stream ends with a named router error and driveStream is never called', async () => {
    const w = world({ classification: { category: 'standard' }, resolvable: {} });
    const orch = new StreamOrchestrator(w.ctx);
    const drive = vi.spyOn(orch, 'driveStream').mockResolvedValue(undefined as never);
    const stream = orch.groupStream(
      { provider: 'router', id: 'dynamic', api: 'x' } as any,
      { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] } as any,
      undefined
    );
    const events: any[] = [];
    for await (const ev of stream as AsyncIterable<any>) events.push(ev);
    expect(drive).not.toHaveBeenCalled();
    const err = events.find((e) => e.type === 'error');
    expect(JSON.stringify(err)).toContain('Dynamic routing failed');
    // The cause is the bare error message: no "Error: " class prefix (String(err) used to add it).
    expect(JSON.stringify(err)).toContain('Dynamic routing failed: No models for dynamic target');
    expect(JSON.stringify(err)).not.toContain('Error: No models');
    expect(JSON.stringify(err)).toContain(
      'dynamic classification and fallback routing both unavailable'
    );
    expect(warnLog).toHaveBeenCalledWith(
      expect.stringContaining('classification failed'),
      expect.anything()
    );
  });

  it('a classifier that throws falls back to the simple group', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: { simple: { candidates: ['openrouter/free'], selected: 'openrouter/free' } },
    });
    w.classifyPrompt.mockRejectedValue(new Error('classifier down'));
    const d = await w.open();
    expect(d.candidates).toEqual(['openrouter/free']);
    expect(d.group).toBe('simple');
  });

  it('with no simple group it falls back to the first non-dynamic group', async () => {
    const w = world({
      classification: { category: 'standard' },
      resolvable: {
        planning: { candidates: ['claude-bridge/opus'], selected: 'claude-bridge/opus' },
      },
    });
    w.classifyPrompt.mockRejectedValue(new Error('classifier down'));
    const d = await w.open();
    expect(d.group).toBe('planning');
    expect(d.candidates).toEqual(['claude-bridge/opus']);
  });
});

describe('HINT matching against the discovered pool only (registry does not know the siblings)', () => {
  it('a qualified hint also matches the same model id under another provider, but never a longer id that merely ends the same way', async () => {
    const w = world({
      keyed: ['mistral'],
      classification: { hintType: 'model', hintTarget: 'mistral/shared-model' },
      discovered: ['mistral/shared-model', 'other/shared-model', 'mistral/not-shared-model'],
      known: ['mistral/shared-model'], // the registry cannot supply the siblings
    });
    const d = await w.open();
    expect(d.candidates).toContain('other/shared-model'); // unusable (unknown to the registry) but kept as last resort
    expect(d.candidates).not.toContain('mistral/not-shared-model');
    expect(d.candidates[0]).toBe('mistral/shared-model');
  });

  it('lists every unusable ref in the skip log, separated by commas', async () => {
    const w = world({
      keyed: ['mistral'],
      classification: { hintType: 'model', hintTarget: 'shared-model' },
      discovered: ['mistral/shared-model', 'a/shared-model', 'b/shared-model'],
      known: ['mistral/shared-model'],
    });
    await w.open();
    expect(routerLog).toHaveBeenCalledWith(
      expect.stringMatching(
        /\(no handler\/credentials\): (a|b)\/shared-model, (a|b)\/shared-model$/
      )
    );
  });
});

// ── a pinned turn still has a category (TODO: pinned continuation) ────────
//
// A user pin (HINT: <model> / HINT: <group>) decides the MODEL. The turn's
// content still has a category, and that category is what the next unpinned
// turn inherits. Before the fix, the pin classification carried no category,
// so lastClassifiedCategory kept the value from before the pin.

const PIN_REF = 'claude-bridge/claude-opus-5-5';
const pinBase = {
  discovered: [PIN_REF],
  known: [PIN_REF],
  gdp: { [PIN_REF]: 1900 },
  keyed: ['mistral', 'openrouter'],
};
const modelPin = { hintType: 'model', hintTarget: PIN_REF, reason: 'pin', confidence: 1.0 };
const contentCategory = (category: string) => ({ category, reason: 'content', confidence: 0.9 });

describe('a pinned turn still classifies its content', () => {
  it('a model pin keeps the pin and remembers the content category', async () => {
    const w = world({
      ...pinBase,
      classification: modelPin,
      lastCategory: 'planning',
      prompt: `HINT: ${PIN_REF} refactor the rate limiter`,
    });
    w.classifyPrompt
      .mockResolvedValueOnce(modelPin as any)
      .mockResolvedValueOnce(contentCategory('standard') as any);
    const d = await w.open();
    expect(d.candidates[0]).toBe(PIN_REF);
    expect(d.label).toBe(`MHINT: ${PIN_REF}`);
    expect(w.ctx.lastClassifiedCategory).toBe('standard');
  });

  it('the content classification receives the prompt without the HINT head', async () => {
    const w = world({
      ...pinBase,
      classification: modelPin,
      prompt: `HINT: ${PIN_REF} refactor the rate limiter`,
    });
    w.classifyPrompt
      .mockResolvedValueOnce(modelPin as any)
      .mockResolvedValueOnce(contentCategory('standard') as any);
    await w.open();
    expect(w.classifyPrompt).toHaveBeenCalledTimes(2);
    const contentCall = w.classifyPrompt.mock.calls[1] as unknown as [string, any];
    expect(contentCall[0]).toBe('refactor the rate limiter');
  });

  it('a group pin keeps the group and remembers the content category', async () => {
    const groupPin = { hintType: 'group', hintTarget: 'planning', reason: 'pin', confidence: 1.0 };
    const w = world({
      resolvable: {
        planning: { candidates: ['claude-bridge/opus'], selected: 'claude-bridge/opus' },
      },
      classification: groupPin,
      lastCategory: 'design',
      prompt: 'HINT: use group planning\nfix the typo in the readme',
    });
    w.classifyPrompt
      .mockResolvedValueOnce(groupPin as any)
      .mockResolvedValueOnce(contentCategory('simple') as any);
    const d = await w.open();
    expect(d.group).toBe('planning');
    expect(w.classifyPrompt.mock.calls[1]).toEqual([
      'fix the typo in the readme',
      expect.anything(),
    ]);
    expect(w.ctx.lastClassifiedCategory).toBe('simple');
  });

  it('an unknown HINT model falls back to the content category, not to a category-less default', async () => {
    const unknown = {
      hintType: 'model',
      hintTarget: 'no-such-model',
      reason: 'pin',
      confidence: 1.0,
    };
    const w = world({
      resolvable: {
        standard: { candidates: ['mistral/glm'], selected: 'mistral/glm' },
        simple: { candidates: ['openrouter/free'], selected: 'openrouter/free' },
      },
      classification: unknown,
      prompt: 'HINT: no-such-model refactor the rate limiter',
    });
    w.classifyPrompt
      .mockResolvedValueOnce(unknown as any)
      .mockResolvedValueOnce(contentCategory('standard') as any);
    const d = await w.open();
    expect(d.group).toBe('standard');
    // standard's own fallback group (simple) follows its candidates
    expect(d.candidates).toEqual(['mistral/glm', 'openrouter/free']);
  });

  it('an automatic (compaction) hint is not a user pin: no second classification', async () => {
    // Characterisation guard, green by design: the compaction continuity hint
    // is the router's own choice, its content is a summary, not a user turn.
    const auto = {
      hintType: 'model',
      hintTarget: PIN_REF,
      reason: 'auto',
      confidence: 1.0,
      origin: 'auto',
    };
    const w = world({ ...pinBase, classification: auto, prompt: 'compact the session' });
    await w.open();
    expect(w.classifyPrompt).toHaveBeenCalledTimes(1);
  });
});
