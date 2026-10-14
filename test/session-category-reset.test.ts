// test/session-category-reset.test.ts
// Sourcery PR #70 review, finding "Prior category leaks across sessions":
// the router process outlives a Pi session, and the stream orchestrator kept
// lastClassifiedCategory across session_shutdown. The FIRST request of a new
// session classified as 'continue' would then inherit the previous session's
// category (e.g. 'design' → planning group) — a conversation-context leak
// across sessions, exactly what the classification-cache never-caching rule
// (content-classifier.ts) exists to prevent.
// Red-first: resetLastCategory did not exist before this fix.

import { describe, it, expect } from 'vitest';
import { StreamOrchestrator } from '../src/stream-orchestrator.ts';

describe('session boundary resets the inheritable category', () => {
  it('resetLastCategory clears a previously classified category', () => {
    const ctx: any = { lastClassifiedCategory: 'design' };
    const orch = new StreamOrchestrator(ctx);
    expect(ctx.lastClassifiedCategory).toBe('design');
    orch.resetLastCategory();
    expect(ctx.lastClassifiedCategory).toBeUndefined();
  });

  it('resetLastCategory is safe when nothing was classified yet', () => {
    const ctx: any = { lastClassifiedCategory: undefined };
    const orch = new StreamOrchestrator(ctx);
    expect(() => orch.resetLastCategory()).not.toThrow();
    expect(ctx.lastClassifiedCategory).toBeUndefined();
  });
});
