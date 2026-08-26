// test/router-info-events.test.ts
// Unit tests for pushRouterInfo() (src/stream-driver.ts) — emits the
// "> [router] ..." status lines (trying next model, cooldown collapse, etc.)
// onto the proxy stream.
//
// Bug this guards against: an earlier version pushed a bare
// { type: 'text_delta', text } event with no `partial` field. Pi's
// compaction path reads `partial.role` off in-flight events, so that shape
// crashed compaction with "Cannot read properties of undefined (reading
// 'role')". The fix emits a full text_start/text_delta/text_end triplet,
// each carrying a `partial` AssistantMessage with `role: 'assistant'`.
//
// pushRouterInfo() used to be a closure-private function inside index.ts's
// activate(). The previous version of this file hand-copied its shape into
// a local `createRouterInfoEvent` helper and asserted that copy against
// itself — it would keep passing even if the real pushRouterInfo regressed
// back to the broken format. Extracting it as a pure exported function
// (alongside pushStreamError, C1) makes it directly testable.

import { describe, it, expect, vi } from 'vitest';
import { pushRouterInfo } from '../src/stream-driver.ts';
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai';

function fakeProxy() {
  const events: any[] = [];
  return {
    proxy: { push: vi.fn((ev: any) => events.push(ev)) } as unknown as AssistantMessageEventStream,
    events,
  };
}

describe('pushRouterInfo', () => {
  it('emits a text_start / text_delta / text_end triplet', () => {
    const { proxy, events } = fakeProxy();
    pushRouterInfo(proxy, '> [router] hello\n');
    expect(events.map((e) => e.type)).toEqual(['text_start', 'text_delta', 'text_end']);
  });

  it('every event carries a partial AssistantMessage with role "assistant"', () => {
    const { proxy, events } = fakeProxy();
    pushRouterInfo(proxy, '> [router] hello\n');
    for (const ev of events) {
      expect(ev.partial).toBeDefined();
      expect(ev.partial.role).toBe('assistant');
    }
    // Accessing partial.role must never throw — this is exactly what
    // crashed Pi's compaction under the old broken format.
    expect(() => events.map((e) => e.partial.role)).not.toThrow();
  });

  it('the text_delta event carries the text on `delta`, not `text`', () => {
    const { proxy, events } = fakeProxy();
    pushRouterInfo(proxy, '> [router] hello\n');
    const delta = events.find((e) => e.type === 'text_delta');
    expect(delta.delta).toBe('> [router] hello\n');
    expect(delta).not.toHaveProperty('text');
  });

  it('uses contentIndex 0 by default and forwards a custom contentIndex', () => {
    const { proxy, events } = fakeProxy();
    pushRouterInfo(proxy, '> [router] hello\n');
    expect(events.every((e) => e.contentIndex === 0)).toBe(true);

    const { proxy: proxy2, events: events2 } = fakeProxy();
    pushRouterInfo(proxy2, '> [router] hello\n', 3);
    expect(events2.every((e) => e.contentIndex === 3)).toBe(true);
  });

  it('text_end carries the full text on `content`', () => {
    const { proxy, events } = fakeProxy();
    pushRouterInfo(proxy, '> [router] All models in standard failed, trying scout...\n\n');
    const end = events.find((e) => e.type === 'text_end');
    expect(end.content).toBe('> [router] All models in standard failed, trying scout...\n\n');
  });
});
