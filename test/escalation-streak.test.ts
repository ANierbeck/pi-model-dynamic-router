// test/escalation-streak.test.ts
// Regression guard: the old rule-based loop detector required a
// frustration/error signal in BOTH of the last 2 turns (`.every()` over
// history.slice(-2)) and only ran every 3rd turn. A user saying "you stopped
// again, please proceed" ONCE — with an ordinary turn right before it — never
// tripped it, because .every() failed on the clean turn. SessionEscalation
// now tracks a streak of the LATEST turn alone, checked every turn, and
// escalates once the same signal repeats STREAK_THRESHOLD (3) times.

import { describe, it, expect, vi } from 'vitest';

// The LLM-based secondary check (every 3rd turn) is fire-and-forget and
// would otherwise attempt a real network call to a local Ollama instance.
// Stub it out so these tests exercise ONLY the synchronous streak logic and
// stay fast/offline; the LLM path has its own coverage concern (it's fire-
// and-forget by design, not synchronously observable from recordTurn()).
vi.mock('../src/ollama-utils.ts', () => ({
  callOllama: vi.fn().mockRejectedValue(new Error('mocked: no ollama in tests')),
}));

import { SessionEscalation } from '../src/escalation.ts';

describe('SessionEscalation — streak-based escalation', () => {
  it('does NOT escalate on a single frustration turn preceded by a clean turn', () => {
    const esc = new SessionEscalation();
    esc.recordTurn('please add a login button', 'Done, added the button.');
    esc.recordTurn('Ok you did stop again, please proceed', 'Continuing...');
    expect(esc.level).toBe('operational');
    expect(esc.correctionStreak).toBe(1);
  });

  it('escalates after the SAME frustration signal repeats 3 times, even with clean turns interleaved differently is NOT required', () => {
    const esc = new SessionEscalation();
    esc.recordTurn('please add a login button', 'Done, added the button.');
    esc.recordTurn('Ok you did stop again, please proceed', 'Continuing...');
    esc.recordTurn('you stopped again, keep going', 'Continuing...');
    expect(esc.level).toBe('operational'); // only 2 so far
    esc.recordTurn('still not done, try again please', 'Continuing...');
    expect(esc.level).toBe('tactical'); // 3rd consecutive signal escalates
    expect(esc.correctionStreak).toBe(0); // streak resets after escalating
  });

  it('resets the streak on a clean turn, requiring 3 fresh consecutive signals', () => {
    const esc = new SessionEscalation();
    esc.recordTurn('again, this is broken', 'Fixing...');
    esc.recordTurn('still broken, again', 'Fixing...');
    // Clean turn breaks the streak.
    esc.recordTurn('looks good now, thanks', 'Great, glad it works.');
    expect(esc.correctionStreak).toBe(0);
    esc.recordTurn('again broken', 'Fixing...');
    esc.recordTurn('still broken', 'Fixing...');
    expect(esc.level).toBe('operational'); // only 2 consecutive since the reset
  });

  it('escalates at most one tier per streak, requiring another 3-streak to escalate further', () => {
    const esc = new SessionEscalation();
    for (let i = 0; i < 3; i++) esc.recordTurn('again failed', 'retrying');
    expect(esc.level).toBe('tactical');
    for (let i = 0; i < 3; i++) esc.recordTurn('still failing again', 'retrying');
    expect(esc.level).toBe('strategic');
    // Already at the top tier — further streaks don't escalate past it.
    for (let i = 0; i < 3; i++) esc.recordTurn('again still broken', 'retrying');
    expect(esc.level).toBe('strategic');
  });

  it('reset() clears the streak along with the level and history', () => {
    const esc = new SessionEscalation();
    esc.recordTurn('again', 'retrying');
    esc.recordTurn('still again', 'retrying');
    expect(esc.correctionStreak).toBe(2);
    esc.reset();
    expect(esc.correctionStreak).toBe(0);
    expect(esc.level).toBe('operational');
  });
});
