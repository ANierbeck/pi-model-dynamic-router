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
    message:
      message ??
      {
        role: 'assistant',
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    ...rest,
  };
}
