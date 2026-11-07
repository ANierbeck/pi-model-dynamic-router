// Shared stream-event fixtures (Prettier round step 5,
// docs/plans/2026-11-05-prettier-formatting.md). The minimal done event was
// spelled near-identically in 16+ test files — real duplication the one-time
// reformat would normalise into the single most-repeated block in the
// redundancy report, so it is owned here once, BEFORE the reformat.
//
// The shape is Pi's AIStreamEvent 'done' as the mock streams in the router
// tests yield it; the tests build it as a plain object, so this helper stays
// untyped on purpose (the orchestrator only reads the fields).

export interface DoneEventOverrides {
  /** Replaces the whole `message` object when given. */
  message?: Record<string, unknown>;
  /** Merged into the event itself (e.g. `reason: 'length'`). */
  [key: string]: unknown;
}

/**
 * The canonical minimal done event most mock streams end with: an empty
 * assistant message, zeroed usage, stop reason. Overrides replace the
 * top-level fields; `message` replaces the message wholesale.
 */
export function doneEvent(overrides: DoneEventOverrides = {}): Record<string, unknown> {
  const { message, ...rest } = overrides;
  return {
    type: 'done',
    reason: 'stop',
    message: message ?? {
      role: 'assistant',
      content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      stopReason: 'stop',
      timestamp: Date.now(),
    },
    ...rest,
  };
}

/**
 * The standard priced-model cost fixture (input 0.1 / output 0.2) used by
 * ~5 test files' model literals.
 */
export function testModelCost(): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  return { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 };
}

/** The standard zeroed Cache literal (~10 files spell the same fields out). */

export function emptyCache(): any {
  return {
    available_models: [],
    gdpval_scores: {},
    model_score_cache: {},
    openrouter_pricing: {},
    usage_log: [],
    benchmarks: {},
    budget_cache: {},
    gdpval_scraped: true,
    lastScanTimestamp: Date.now(),
  };
}

/**
 * The standard paid-cloud model fixture (provider 'paid-cloud-provider',
 * id 'paid-model', 1M context, testModelCost()) — ~5 files spell the same
 * literal. Overrides merge on top.
 */
export function paidCloudModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'paid-cloud-provider',
    id: 'paid-model',
    api: 'openai-completions',
    contextWindow: 1_000_000,
    cost: testModelCost(),
    ...overrides,
  };
}

/**
 * The hermetic scan-cache flags (fresh timestamp, gdpval scraped) — the
 * two lines ~8 files repeat inside larger cache literals.
 */
export function hermeticCacheFlags(): { gdpval_scraped: boolean; lastScanTimestamp: number } {
  return { gdpval_scraped: true, lastScanTimestamp: Date.now() };
}

/**
 * The message list of a tool follow-up step: one user message, then a bash
 * tool result. groupStream treats a list whose last message is a toolResult as
 * a follow-up; three orchestrator test files spelled it out identically.
 */
export function toolFollowUpMessages(userText = 'run it'): Record<string, unknown>[] {
  return [
    { role: 'user', content: userText, timestamp: 1 },
    {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'ok' }],
      timestamp: 2,
    },
  ];
}
