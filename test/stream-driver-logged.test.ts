// test/stream-driver-logged.test.ts
// Regression guard: pushRouterInfo alone never wrote to router.log — the
// "> [router] X — reason, trying Y" messages the user sees live in chat left
// no durable trace once the turn ended. pushRouterInfoLogged must write a
// greppable line to router.log (via routerLog) in addition to pushing the
// same chat events pushRouterInfo does.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { routerLogSpy } = vi.hoisted(() => ({ routerLogSpy: vi.fn() }));
vi.mock('../src/logger.ts', () => ({
  routerLog: routerLogSpy,
}));

import { pushRouterInfo, pushRouterInfoLogged } from '../src/stream-driver.ts';

function fakeProxy() {
  const events: any[] = [];
  return {
    events,
    push: (ev: any) => events.push(ev),
  };
}

beforeEach(() => {
  routerLogSpy.mockClear();
});

describe('pushRouterInfoLogged', () => {
  it('writes a durable router.log line in addition to the chat events', () => {
    const proxy = fakeProxy();
    pushRouterInfoLogged(proxy as any, '> [router] openrouter/foo — rate limit/spend limit reached, trying openrouter/bar …\n\n');

    expect(routerLogSpy).toHaveBeenCalledTimes(1);
    // The leading "> " chat-formatting marker is stripped before logging.
    const loggedText = routerLogSpy.mock.calls[0][0];
    expect(loggedText.startsWith('>')).toBe(false);
    expect(loggedText).toContain('[router] openrouter/foo — rate limit/spend limit reached, trying openrouter/bar');
  });

  it('still pushes the same text_start/text_delta/text_end triplet as pushRouterInfo', () => {
    const proxyLogged = fakeProxy();
    const proxyPlain = fakeProxy();
    const text = '> [router] some/model\n\n';

    pushRouterInfoLogged(proxyLogged as any, text);
    pushRouterInfo(proxyPlain as any, text);

    expect(proxyLogged.events.map((e) => e.type)).toEqual(proxyPlain.events.map((e) => e.type));
    expect(proxyLogged.events.map((e) => e.delta ?? e.content)).toEqual(
      proxyPlain.events.map((e) => e.delta ?? e.content)
    );
  });

  it('does not throw or log when routerLog is unavailable-like (defensive smoke test)', () => {
    const proxy = fakeProxy();
    expect(() => pushRouterInfoLogged(proxy as any, '> [router] plain message\n\n')).not.toThrow();
    expect(proxy.events.length).toBe(3);
  });
});
