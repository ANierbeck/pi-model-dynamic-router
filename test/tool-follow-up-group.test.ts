// test/tool-follow-up-group.test.ts
// docs/plans/2026-11-07-tool-follow-up-group.md (TODO I3).
//
// A tool follow-up step (last message is a toolResult) used to fall into the
// `simple` group whatever group the run started in: a planning/design/
// code_complex run whose driver hit one 429 finished on cheap or free models and
// stayed there after the driver's cooldown. The run's group and driver are now
// remembered at classification; the follow-up orders driver (once cooled down) ->
// current ref -> the run group's candidates -> its fallback groups, and skips
// free-tier models while tools are in the context unless the run is a `simple` one.
//
// driveStream is spied; every assertion is on what groupStream hands to it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamOrchestrator } from '../src/stream-orchestrator.ts';
import { runAsSubCall } from '../src/subcall-scope.ts';
import { toolFollowUpMessages } from './helpers/stream-fixtures.ts';

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

const GROUPS = {
  dynamic: { method: 'dynamic' },
  planning: { method: 'best', fallback_groups: ['standard'] },
  code_complex: { method: 'best', fallback_groups: ['simple'] },
  standard: { method: 'best', fallback_groups: ['simple'] },
  simple: { method: 'best' },
};

const POOLS: Record<string, { candidates: string[]; selected: string }> = {
  planning: { candidates: ['claude/opus', 'claude/sonnet'], selected: 'claude/opus' },
  code_complex: { candidates: ['mistral/large', 'mistral/glm'], selected: 'mistral/large' },
  standard: { candidates: ['mistral/glm', 'mistral/small'], selected: 'mistral/glm' },
  simple: {
    candidates: ['openrouter/cheap:free', 'mistral/tiny'],
    selected: 'openrouter/cheap:free',
  },
};

const turnMessages = [{ role: 'user', content: 'plan the refactor', timestamp: 1 }];
const followUpMessages = toolFollowUpMessages('plan the refactor');

function followUpWorld(opts: { limited?: string[]; free?: string[]; pools?: typeof POOLS } = {}) {
  const pools = { ...POOLS, ...opts.pools };
  const limited = new Set(opts.limited ?? []);
  const breakerOpen = new Set<string>();
  let classification: any = { category: 'planning' };
  const ctx: any = {
    cfg: {
      model_groups: GROUPS,
      model_metrics: {},
      providers: { openrouter: { free_models: opts.free ?? [] } },
    },
    cache: {},
    router: { allDiscoveredRefs: () => [], getTopModels: () => ({ models: [] }) },
    lastDynamicModel: '',
    lastClassifiedCategory: undefined,
    escalation: { level: 'standard' },
    sessionCtx: undefined,
    resolve: (name: string) => {
      const p = pools[name];
      return p ? { candidates: [...p.candidates], selected: p.selected } : null;
    },
    extractLastUserPrompt: () => 'plan the refactor',
    extractLastAssistantSnippet: () => '',
    detectHintDirectly: vi.fn(() => null),
    isCompactionTurn: () => false,
    isLimited: (ref: string) => limited.has(ref),
    isBreakerOpen: (ref: string) => breakerOpen.has(ref),
    isLocalProvider: () => false,
    clearLimit: () => {},
    lookupGdp: () => null,
    getGroupForCategory: (category: string) => category,
    classifyPrompt: vi.fn(async () => classification),
  };
  const orch = new StreamOrchestrator(ctx);
  const drive = vi.spyOn(orch, 'driveStream').mockResolvedValue(undefined as never);
  const open = async (
    messages: any[],
    tools?: unknown[]
  ): Promise<{ candidates: string[]; group: string | undefined }> => {
    const before = drive.mock.calls.length;
    orch.groupStream(
      { provider: 'router', id: 'dynamic', api: 'openai-completions' } as any,
      { messages, ...(tools ? { tools } : {}) } as any,
      undefined
    );
    await vi.waitFor(() => expect(drive.mock.calls.length).toBeGreaterThan(before));
    const a = drive.mock.calls[before] as unknown as any[];
    return { candidates: a[1] as string[], group: a[5] as string | undefined };
  };
  return {
    ctx,
    open,
    classifyPrompt: ctx.classifyPrompt as ReturnType<typeof vi.fn>,
    limit: (ref: string) => limited.add(ref),
    openBreaker: (ref: string) => breakerOpen.add(ref),
    setPool: (name: string, p: { candidates: string[]; selected: string }) => {
      pools[name] = p;
    },
    unlimit: (ref: string) => limited.delete(ref),
    classifyAs: (c: any) => {
      classification = c;
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('tool follow-up keeps the run’s group', () => {
  it('a planning run continues in planning after its driver failed over, not in simple', async () => {
    const w = followUpWorld({ limited: ['claude/opus'] });
    await w.open(turnMessages); // classification: run = planning, driver = claude/opus
    w.ctx.lastDynamicModel = 'claude/sonnet'; // what recordServedRef sets after the failover
    const d = await w.open(followUpMessages);
    expect(d.group).toBe('planning');
    // driver still cooling down: current ref first, then the run group, then its fallback group
    expect(d.candidates).toEqual(['claude/sonnet', 'claude/opus', 'mistral/glm', 'mistral/small']);
    expect(w.classifyPrompt).toHaveBeenCalledTimes(1); // the follow-up does not classify
  });

  it('the driver comes back first once its cooldown has expired', async () => {
    const w = followUpWorld({ limited: ['claude/opus'] });
    await w.open(turnMessages);
    w.ctx.lastDynamicModel = 'claude/sonnet';
    w.unlimit('claude/opus');
    const d = await w.open(followUpMessages);
    expect(d.group).toBe('planning');
    expect(d.candidates.slice(0, 2)).toEqual(['claude/opus', 'claude/sonnet']);
  });

  it('a new user turn starts a new run: the next follow-up follows the new group', async () => {
    const w = followUpWorld();
    await w.open(turnMessages); // planning
    w.classifyAs({ category: 'code_complex' });
    await w.open([...turnMessages, { role: 'user', content: 'now fix the bug', timestamp: 3 }]);
    w.ctx.lastDynamicModel = 'mistral/large';
    const d = await w.open(followUpMessages);
    expect(d.group).toBe('code_complex');
    expect(d.candidates[0]).toBe('mistral/large');
  });

  it('a pinned group (HINT: <group>) is the run’s group too', async () => {
    const w = followUpWorld();
    w.classifyAs({ hintType: 'group', hintTarget: 'code_complex' });
    await w.open(turnMessages);
    w.ctx.lastDynamicModel = 'mistral/large';
    const d = await w.open(followUpMessages);
    expect(d.group).toBe('code_complex');
  });

  it('a turn whose classification throws does not inherit the previous run', async () => {
    const w = followUpWorld();
    await w.open(turnMessages); // run = planning
    w.classifyPrompt.mockRejectedValueOnce(new Error('classifier down'));
    await w.open([...turnMessages, { role: 'user', content: 'and now?', timestamp: 3 }]); // served from simple
    w.ctx.lastDynamicModel = 'mistral/tiny';
    const d = await w.open(followUpMessages);
    expect(d.group).toBe('simple');
  });

  it('a router sub-call (bulk_read) does not become the run', async () => {
    const w = followUpWorld();
    await w.open(turnMessages); // planning
    w.classifyAs({ category: 'standard' });
    await runAsSubCall(() => w.open([{ role: 'user', content: 'read the files', timestamp: 4 }]));
    w.ctx.lastDynamicModel = 'claude/opus';
    const d = await w.open(followUpMessages);
    expect(d.group).toBe('planning');
  });
});

describe('tool follow-up and free-tier models', () => {
  const tools = [{ name: 'bash' }];

  it('skips free models while tools are in the context (non-simple run)', async () => {
    const w = followUpWorld({ free: ['openrouter/cheap:free'] });
    w.classifyAs({ category: 'code_complex' });
    await w.open(turnMessages);
    w.ctx.lastDynamicModel = 'openrouter/cheap:free'; // a failover landed on the free tier
    const d = await w.open(followUpMessages, tools);
    expect(d.group).toBe('code_complex');
    expect(d.candidates).not.toContain('openrouter/cheap:free');
    expect(d.candidates[0]).toBe('mistral/large');
  });

  it('keeps a free driver the run itself started on (a pinned or group-selected free model)', async () => {
    const w = followUpWorld({
      free: ['openrouter/pinned:free'],
      pools: {
        code_complex: {
          candidates: ['openrouter/pinned:free', 'mistral/large'],
          selected: 'openrouter/pinned:free',
        },
      },
    });
    w.classifyAs({ category: 'code_complex' });
    await w.open(turnMessages); // driver = the free model
    w.ctx.lastDynamicModel = 'openrouter/pinned:free';
    const d = await w.open(followUpMessages, tools);
    expect(d.candidates[0]).toBe('openrouter/pinned:free');
  });

  it('skips a meta-router ref like a free model while tools are in the context', async () => {
    const w = followUpWorld({
      pools: {
        code_complex: {
          candidates: ['mistral/large', 'openrouter/openrouter/free'],
          selected: 'mistral/large',
        },
      },
    });
    w.classifyAs({ category: 'code_complex' });
    await w.open(turnMessages);
    const d = await w.open(followUpMessages, tools);
    expect(d.candidates).not.toContain('openrouter/openrouter/free');
  });

  it('keeps free models when no tools are in the context', async () => {
    const w = followUpWorld({ free: ['openrouter/cheap:free'] });
    w.classifyAs({ category: 'code_complex' });
    await w.open(turnMessages);
    w.ctx.lastDynamicModel = 'openrouter/cheap:free';
    const d = await w.open(followUpMessages);
    // driver first (cooldown over), the free model currently serving right behind it
    expect(d.candidates.slice(0, 2)).toEqual(['mistral/large', 'openrouter/cheap:free']);
  });

  it('fails open: when every candidate is free the list is kept', async () => {
    const w = followUpWorld({
      free: [
        'mistral/large',
        'mistral/glm',
        'mistral/small',
        'openrouter/cheap:free',
        'mistral/tiny',
      ],
    });
    w.classifyAs({ category: 'code_complex' });
    await w.open(turnMessages);
    const d = await w.open(followUpMessages, tools);
    expect(d.candidates.length).toBeGreaterThan(0);
  });
});

describe('tool follow-up of a simple run is unchanged', () => {
  it('keeps today’s order and group', async () => {
    const w = followUpWorld({ free: ['openrouter/cheap:free'] });
    w.classifyAs({ category: 'simple' });
    await w.open(turnMessages);
    w.ctx.lastDynamicModel = 'mistral/tiny';
    const d = await w.open(followUpMessages, [{ name: 'bash' }]);
    expect(d.group).toBe('simple');
    expect(d.candidates).toEqual(['mistral/tiny', 'openrouter/cheap:free']);
  });

  it('without a remembered run (state lost) falls back to the simple pool', async () => {
    const w = followUpWorld();
    w.ctx.lastDynamicModel = 'mistral/large';
    const d = await w.open(followUpMessages);
    expect(d.group).toBe('simple');
    expect(d.candidates).toEqual(['mistral/large', 'openrouter/cheap:free', 'mistral/tiny']);
  });
});

// docs/plans/2026-10-26-continue-keeps-model.md: a `continue` prompt says
// "nothing new, keep going". The category was always inherited; the MODEL used
// to be re-ranked, so a ranking change between two turns switched models on a
// cold prompt cache. Now the previous model leads the candidate list when it is
// a candidate of the inherited group and usable now. Owner decisions 2026-11-07:
// only `continue` (S1), keep past any quality gap (S2), first prompt -> normal (S3).
describe('a continue turn keeps the previous model', () => {
  const continueTurn = [...turnMessages, { role: 'user', content: 'ok, go on', timestamp: 5 }];
  const inherited = { category: 'planning', inheritedFromContinue: true };

  async function flippedRanking(w: ReturnType<typeof followUpWorld>) {
    await w.open(turnMessages); // planning: opus leads and serves
    w.ctx.lastDynamicModel = 'claude/opus';
    // Health, pacing or a cost tie flips the group ranking between the turns.
    w.setPool('planning', {
      candidates: ['claude/sonnet', 'claude/opus'],
      selected: 'claude/sonnet',
    });
    w.classifyAs(inherited);
  }

  it('keeps the previous model first although the ranking flipped; the rest stays ranked', async () => {
    const w = followUpWorld();
    await flippedRanking(w);
    const d = await w.open(continueTurn);
    expect(d.group).toBe('planning');
    expect(d.candidates.slice(0, 2)).toEqual(['claude/opus', 'claude/sonnet']);
    // the failure cascade behind it is the group's ranking plus its fallback groups, unchanged
    expect(d.candidates).toEqual(['claude/opus', 'claude/sonnet', 'mistral/glm', 'mistral/small']);
  });

  it('the kept model also drives the run: the tool follow-up that follows starts on it', async () => {
    const w = followUpWorld();
    await flippedRanking(w);
    await w.open(continueTurn);
    expect(w.ctx.lastDynamicModel).toBe('claude/opus');
    expect(w.ctx.runDriver).toBe('claude/opus'); // the run was started on the kept model
    const d = await w.open(followUpMessages);
    expect(d.candidates[0]).toBe('claude/opus');
  });

  it('without the marker (a real new task) the ranking decides, as before', async () => {
    const w = followUpWorld();
    await flippedRanking(w);
    w.classifyAs({ category: 'planning' });
    const d = await w.open(continueTurn);
    expect(d.candidates[0]).toBe('claude/sonnet');
  });

  it('does not keep a rate-limited previous model', async () => {
    const w = followUpWorld();
    await flippedRanking(w);
    w.limit('claude/opus');
    const d = await w.open(continueTurn);
    expect(d.candidates[0]).toBe('claude/sonnet');
  });

  it('does not keep a previous model whose provider breaker is open', async () => {
    const w = followUpWorld();
    await flippedRanking(w);
    w.openBreaker('claude/opus');
    const d = await w.open(continueTurn);
    expect(d.candidates[0]).toBe('claude/sonnet');
  });

  it('does not keep a previous model the inherited group does not contain', async () => {
    const w = followUpWorld();
    await flippedRanking(w);
    w.ctx.lastDynamicModel = 'mistral/tiny'; // from another group, not a planning candidate
    const d = await w.open(continueTurn);
    expect(d.candidates[0]).toBe('claude/sonnet');
  });

  it('keeps a previous model that served from the group’s fallback groups', async () => {
    const w = followUpWorld();
    await flippedRanking(w);
    w.ctx.lastDynamicModel = 'mistral/glm'; // planning failed over to standard
    const d = await w.open(continueTurn);
    expect(d.candidates).toEqual(['mistral/glm', 'claude/sonnet', 'claude/opus', 'mistral/small']);
  });

  it('the first prompt of a session has no previous model: normal ranking', async () => {
    const w = followUpWorld();
    w.classifyAs(inherited);
    const d = await w.open(continueTurn);
    expect(d.candidates[0]).toBe('claude/opus');
  });

  it('an escalated session keeps the escalation group’s ranking', async () => {
    const w = followUpWorld();
    await flippedRanking(w);
    w.ctx.escalation = { level: 'planning' };
    const d = await w.open(continueTurn);
    expect(d.candidates[0]).toBe('claude/sonnet');
  });

  it('a router-internal sub-call never keeps the turn model', async () => {
    const w = followUpWorld();
    await flippedRanking(w);
    const d = await runAsSubCall(() => w.open(continueTurn));
    expect(d.candidates[0]).toBe('claude/sonnet');
  });
});
