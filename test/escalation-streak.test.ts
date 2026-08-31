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
import { callOllama } from '../src/ollama-utils.ts';

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

  // roborev job 373 MEDIUM: index.ts's only real call site invokes
  // recordTurn() TWICE per logical exchange — once with (userText, '') on
  // the user's turn_end, once with ('', assistantText) on the assistant's
  // turn_end — not once with both populated together as the tests above do.
  it('advances the streak by exactly 1 per exchange under the real split-call pattern (user, then assistant)', () => {
    const esc = new SessionEscalation();
    // Exchange 1: user turn_end, then assistant turn_end (split calls, as index.ts does).
    esc.recordTurn('please add a login button', '');
    esc.recordTurn('', 'Done, added the button.');
    expect(esc.correctionStreak).toBe(0);

    // Exchange 2: user says "again" — streak should advance by exactly 1,
    // not 2, even though this exchange is also 2 separate recordTurn() calls.
    esc.recordTurn('Ok you did stop again, please proceed', '');
    esc.recordTurn('', 'Continuing...');
    expect(esc.correctionStreak).toBe(1);

    esc.recordTurn('still not done, try again', '');
    esc.recordTurn('', 'Continuing...');
    expect(esc.correctionStreak).toBe(2);

    esc.recordTurn('you stopped again', '');
    esc.recordTurn('', 'Continuing...');
    expect(esc.correctionStreak).toBe(0); // reset after escalating on the 3rd
    expect(esc.level).toBe('tactical');
  });

  it('is NOT driven by frustration/error keywords in the router\'s own assistant-side fallback text', () => {
    const esc = new SessionEscalation();
    // The assistant's response can legitimately contain router-injected
    // fallback narration like "... error: ..." or "... failed, trying ..."
    // (pushRouterInfo/pushRouterInfoLogged) with zero real user frustration
    // behind it. Three such assistant-only turns must not escalate anything.
    esc.recordTurn('', 'openrouter/foo — error: rate limited, trying openrouter/bar …');
    esc.recordTurn('', 'All models in scout failed, trying operational...');
    esc.recordTurn('', 'mistral/baz — error: empty response, trying mistral/qux …');
    expect(esc.correctionStreak).toBe(0);
    expect(esc.level).toBe('operational');
  });

  // roborev job 376 MEDIUM: the periodic LLM-check trigger
  // ((history.length - 2) % 3 === 0) fires on raw call count, not on which
  // half of the split user/assistant exchange it lands on. It can fire on
  // the assistant-only call immediately AFTER a streak escalation (history
  // length 8, right after the escalating call at length 7) — the
  // "already escalated this turn" guard must still suppress a second LLM-
  // driven escalation in that case, even though it's a different recordTurn
  // call than the one that streak-escalated.
  it('does not stack an LLM-driven escalation on top of a streak escalation that just happened one call earlier', async () => {
    vi.mocked(callOllama).mockResolvedValue('{"shouldEscalate": true, "reason": "test says escalate"}');
    const esc = new SessionEscalation();

    esc.recordTurn('hello', ''); // len 1
    esc.recordTurn('', 'hi'); // len 2
    esc.recordTurn('again', ''); // len 3, streak 1
    esc.recordTurn('', 'ok'); // len 4
    esc.recordTurn('still again', ''); // len 5, streak 2
    esc.recordTurn('', 'ok'); // len 6
    esc.recordTurn('again please', ''); // len 7, streak 3 -> escalates to 'tactical'
    expect(esc.level).toBe('tactical');
    // len 8, assistant-only call: (8-2)%3===0 fires _checkAndEscalate here,
    // one call after the streak escalation — not the same call.
    esc.recordTurn('', 'ok');

    // Let the mocked (immediately-resolved) LLM promise's .then() run.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Must still be 'tactical', not 'strategic' — the LLM's shouldEscalate:
    // true must NOT stack a second bump on top of the streak's.
    expect(esc.level).toBe('tactical');
  });
});
