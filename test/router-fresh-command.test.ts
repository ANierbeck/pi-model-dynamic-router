// Task-type balancing step 5c (docs/plans/2026-11-19-fresh-session-suggestion.md):
// `/router fresh` — the ONLY place a session switch may come from. Red-first
// per AGENTS.md §4, written against the unwired command.

import { describe, it, expect, vi } from 'vitest';
import { createCommands } from '../src/commands.ts';
import { FRESH_WAIT_MS } from '../src/fresh-session.ts';

type Handler = (args: string, ctx: unknown) => Promise<void>;

/** Minimal CommandDeps rig + the captured /router handler, as in test/router-command-help.test.ts. */
function freshRig() {
  const cmds: Record<string, { handler: Handler }> = {};
  const onHandlers: Record<string, (ev: unknown) => void> = {};
  const rt = {
    pi: {
      registerCommand: (name: string, d: { handler: Handler }) => {
        cmds[name] = d;
      },
      on: (event: string, h: (ev: unknown) => void) => {
        onHandlers[event] = h;
        return () => {
          delete onHandlers[event];
        };
      },
      // Extensions may load pi-ExtensionAPI surface we don't exercise here.
    },
    load: () => {},
    sessionCtx: undefined,
    router: { setSessionCtx: () => {} },
    cfg: {},
  };
  createCommands(rt as never);
  return { handler: cmds['router'].handler, onHandlers };
}

/** The command ctx: TUI mode, dialog-capable ui, session-control stubs. */
function freshCtx(over: Record<string, unknown> = {}): any {
  return {
    mode: 'tui',
    ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true) },
    compact: vi.fn(),
    newSession: vi.fn(async (): Promise<{ cancelled: boolean }> => ({ cancelled: false })),
    ...over,
  };
}

describe('/router fresh', () => {
  it('declined confirm: nothing is compacted and no session is started', async () => {
    const rig = freshRig();
    const ctx = freshCtx({ ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(false) } });
    await rig.handler('fresh', ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(ctx.newSession).not.toHaveBeenCalled();
    expect(ctx.ui.notify.mock.calls.some((c) => String(c[0]).match(/cancelled/i))).toBe(true);
  });

  it('accepted + compaction completes: newSession carries the handoff as its first message', async () => {
    const rig = freshRig();
    const ctx = freshCtx();
    // The handler chain suspends at the confirm dialog: drive it with a
    // microtask flush between handler start and the compact assertion.
    const p = rig.handler('fresh finish the laya gate', ctx).then(() => 'done');
    await vi.waitFor(() =>
      expect(ctx.compact).toHaveBeenCalledWith(
        expect.objectContaining({ customInstructions: expect.stringMatching(/handover/i) })
      )
    );
    rig.onHandlers['session_compact']?.({ compactionEntry: { summary: 'The task was X' } });
    expect(await p).toBe('done');

    expect(ctx.newSession).toHaveBeenCalledTimes(1);
    const opts = ctx.newSession.mock.calls[0][0] as {
      parentSession?: string;
      withSession: (fresh: unknown) => Promise<void>;
    };
    // The HOST records the parent link (agent-session-runtime); we must not pass it.
    expect(opts.parentSession).toBeUndefined();

    const sendMessage = vi.fn(async () => undefined);
    const notify = vi.fn();
    await opts.withSession({ sendMessage, ui: { notify } });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [message, sendOpts] = sendMessage.mock.calls[0] as [string, { triggerTurn?: boolean }];
    expect(message).toContain('The task was X');
    expect(message).toContain('finish the laya gate');
    expect(sendOpts).toMatchObject({ triggerTurn: true });
  });

  it('compaction never completes: the handoff ships with a skeleton summary (fail-open)', async () => {
    vi.useFakeTimers();
    try {
      const rig = freshRig();
      const ctx = freshCtx();
      const p = rig.handler('fresh', ctx).then(() => 'done');
      await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(FRESH_WAIT_MS);
      expect(await p).toBe('done');
      const opts = ctx.newSession.mock.calls[0][0] as {
        withSession: (fresh: unknown) => Promise<void>;
      };
      const sendMessage = vi.fn(async () => undefined);
      await opts.withSession({ sendMessage, ui: { notify: vi.fn() } });
      expect(sendMessage.mock.calls[0][0]).toMatch(/summary was unavailable/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('outside the TUI: a warning, no dialogs, no switch', async () => {
    const rig = freshRig();
    const ctx = freshCtx({ mode: 'rpc' });
    await rig.handler('fresh', ctx);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(ctx.newSession).not.toHaveBeenCalled();
    expect(ctx.ui.notify.mock.calls[0][1]).toBe('warning');
  });

  it('a FAILED compaction resolves at once to the skeleton handoff (PR #193 review P2)', async () => {
    const rig = freshRig();
    const ctx = freshCtx();
    const p = rig.handler('fresh', ctx).then(() => 'done');
    await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
    rig.onHandlers['session_compact_failed']?.({ reason: 'threshold', aborted: false });
    expect(await p).toBe('done'); // NO timer advance needed
    const opts = ctx.newSession.mock.calls[0][0] as {
      withSession: (fresh: unknown) => Promise<void>;
    };
    const sendMessage = vi.fn(async () => undefined);
    await opts.withSession({ sendMessage, ui: { notify: vi.fn() } });
    expect(sendMessage.mock.calls[0][0]).toMatch(/summary was unavailable/i);
  });

  it('the wait is announced (no silent 30s); the timeout branch unsubscribes (review P2)', async () => {
    vi.useFakeTimers();
    try {
      const rig = freshRig();
      const ctx = freshCtx();
      const p = rig.handler('fresh', ctx).then(() => 'done');
      await vi.waitFor(() => expect(ctx.compact).toHaveBeenCalledTimes(1));
      // Announced: a progress line about the compaction summary appears
      // before any handoff/search feedback.
      expect(ctx.ui.notify.mock.calls.some((c) => String(c[0]).match(/handoff|summary/i))).toBe(
        true
      );
      // The subscription is still live while waiting.
      expect(rig.onHandlers['session_compact']).toBeDefined();
      await vi.advanceTimersByTimeAsync(FRESH_WAIT_MS);
      expect(await p).toBe('done');
      // Timeout branch unsubscribed the listener (review P2: it used to stay
      // subscribed until the NEXT session_compact).
      expect(rig.onHandlers['session_compact']).toBeUndefined();
      const opts = ctx.newSession.mock.calls[0][0] as {
        withSession: (fresh: unknown) => Promise<void>;
      };
      const sendMessage = vi.fn(async () => undefined);
      await opts.withSession({ sendMessage, ui: { notify: vi.fn() } });
      expect(sendMessage.mock.calls[0][0]).toMatch(/summary was unavailable/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
