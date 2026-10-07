// test/classification-counters.test.ts
// Phase 0 step 2 of docs/plans/2026-10-05-task-type-balancing.md: the
// /router status must show how the day's prompts were classified — by
// which source (cloud / ollama / momentum / hint / cache / static / ...) and
// into which category. Evidence 2 of the plan (~60% of turns classified
// `fallback`) had to be dug out of the router log by hand; the counters make
// it visible in the status block.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/ollama-utils', () => ({
  callOllama: vi.fn(),
  isOllamaAvailable: vi.fn(async () => true),
  isOllamaWedged: vi.fn(() => false),
}));

import { callOllama } from '../src/ollama-utils';
import { classifyPrompt, getClassificationCounts, resetClassificationCounts } from '../src/content-classifier.ts';
import { formatClassifierStatus } from '../src/commands.ts';
import type { Group } from '../src/types.ts';
import { localModelCache } from './helpers/local-model-cache.ts';

const json = (category: string) => JSON.stringify({ category, reason: 'test', confidence: 0.9 });

beforeEach(() => {
  vi.mocked(callOllama).mockReset();
  resetClassificationCounts();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('classification counters (Phase 0 step 2)', () => {
  it('counts each classification by coarse source and by category', async () => {
    vi.mocked(callOllama).mockResolvedValue(json('code_complex'));
    await classifyPrompt('refactor the stream orchestrator into three modules, counter probe one', { cache: localModelCache() });
    await classifyPrompt('yes do it', { context: { lastCategory: 'design' } });
    await classifyPrompt('HINT: use mistral/zai-glm-5-3 please fix the failing test');

    const c = getClassificationCounts();
    expect(c.total).toBe(3);
    // 'ollama:<model>' collapses to 'ollama' — the status shows the mix, the
    // exact model is already on the "last used" line.
    expect(c.bySource).toEqual({ ollama: 1, momentum: 1, hint: 1 });
    expect(c.byCategory.code_complex).toBe(1);
    expect(c.byCategory.design).toBe(1);
    // A HINT carries no category — it is counted under its hint type.
    expect(c.byCategory['hint:model']).toBe(1);
  });

  it('starts a fresh count when the local day changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 6, 23, 50));
    await classifyPrompt('ok go', { context: { lastCategory: 'planning' } });
    expect(getClassificationCounts().total).toBe(1);

    vi.setSystemTime(new Date(2026, 9, 7, 0, 10));
    expect(getClassificationCounts().total).toBe(0);
    await classifyPrompt('ok go', { context: { lastCategory: 'planning' } });
    expect(getClassificationCounts()).toMatchObject({ day: '2026-10-07', total: 1 });
  });
});

describe('formatClassifierStatus renders the day counters', () => {
  const group = {
    name: 'dynamic', method: 'dynamic', models: [], classifier_cloud_fallback: true,
  } as unknown as Group;

  it('shows sources and categories, most frequent first', () => {
    const lines = formatClassifierStatus({
      group,
      last: null,
      probedCount: 1,
      ollamaUp: false,
      counts: {
        day: '2026-10-06',
        total: 10,
        bySource: { cloud: 6, momentum: 3, hint: 1 },
        byCategory: { fallback: 6, code_complex: 3, 'hint:model': 1 },
      },
    });
    const today = lines.find((l) => l.includes('Today:')) ?? '';
    expect(today).toContain('10 classified');
    expect(today).toContain('cloud 6, momentum 3, hint 1');
    const cats = lines.find((l) => l.includes('Categories:')) ?? '';
    expect(cats).toContain('fallback 6 (60%), code_complex 3 (30%), hint:model 1 (10%)');
  });

  it('omits the counter lines before the first classification of the day', () => {
    const lines = formatClassifierStatus({
      group, last: null, probedCount: 1, ollamaUp: false,
      counts: { day: '2026-10-06', total: 0, bySource: {}, byCategory: {} },
    });
    expect(lines.some((l) => l.includes('Today:'))).toBe(false);
  });
});

describe('formatCategoryRoutes — the /router route list matches the live mapping', () => {
  // Found while adding the counters (AGENTS.md §7): the block hardcoded
  // 'design→strategic', 'planning→tactical', 'code_simple→operational'
  // while CATEGORY_TO_GROUP routes design/planning → planning (ADR-0023
  // follow-up) and code_simple → simple. The status lied about the routing.
  it('lists every category with the group CATEGORY_TO_GROUP actually routes it to', async () => {
    const { formatCategoryRoutes } = await import('../src/commands.ts');
    const { CATEGORY_TO_GROUP } = await import('../src/content-classifier.ts');
    expect(formatCategoryRoutes()).toEqual(
      Object.entries(CATEGORY_TO_GROUP).map(([cat, group]) => `${cat}→${group}`)
    );
  });
});

describe('classification counters under overlapping calls (review 2026-10-06, minor 5)', () => {
  it('attributes each call to ITS OWN source, not whichever finished last', async () => {
    // A is an LLM call that completes late; B is a deterministic momentum
    // continuation that completes while A is still in flight. A global
    // "last source" read after the await would credit both to one source.
    let releaseA: (v: string) => void = () => {};
    vi.mocked(callOllama).mockImplementation(
      () => new Promise<string>((res) => { releaseA = res; })
    );
    const a = classifyPrompt('refactor the stream orchestrator into three modules, overlap probe a', { cache: localModelCache() });
    // Let A reach its (pending) Ollama call.
    await new Promise((r) => setTimeout(r, 0));
    // A's answer arrives and, in the same tick, B (momentum) starts and
    // records ITS source before A's continuation reads the shared state.
    releaseA(json('code_complex'));
    const b = classifyPrompt('yes do it', { context: { lastCategory: 'design' } });
    await Promise.all([a, b]);

    const c = getClassificationCounts();
    expect(c.total).toBe(2);
    expect(c.bySource).toEqual({ ollama: 1, momentum: 1 });
  });
});
