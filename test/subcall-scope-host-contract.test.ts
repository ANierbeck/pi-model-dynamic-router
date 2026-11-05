// Host contract behind src/subcall-scope.ts: the sub-call scope is an
// AsyncLocalStorage store, so it only works if Pi's REAL model runtime invokes
// a provider's streamSimple inside the async chain of the caller (Pi 1.4/1.5
// wrap it in lazyStream + an async auth step). The mocks in
// subcall-scope-isolation.test.ts cannot prove that; this drives the real
// ModelRuntime. If a Pi update queues the provider call on a pre-existing
// async resource, this test fails and the scope must move to an explicit
// marker instead of silently going blind.
//
// Not red-first (a host-behaviour pin has nothing to fail against); the
// outside-the-scope call is the negative control that keeps it non-vacuous.

import { describe, it, expect } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { runAsSubCall, inSubCall } from '../src/subcall-scope.ts';

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  await Promise.race([
    (async () => {
      try {
        for await (const _ of stream) void _;
      } catch {
        // the probe provider ends without a message; the call itself is what matters
      }
    })(),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
}

describe('Pi runtime carries async context into provider.streamSimple', () => {
  it('a router stream opened inside runAsSubCall sees inSubCall(); one opened outside does not', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subcall-host-'));
    try {
      fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
      const runtime = await ModelRuntime.create({
        authPath: path.join(dir, 'auth.json'),
        modelsPath: null,
      });
      const registry = new ModelRegistry(runtime);
      const seen: boolean[] = [];
      registry.registerProvider('probe', {
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'x',
        api: 'openai-completions',
        models: [
          {
            id: 'm',
            name: 'm',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 100,
          },
        ],
        streamSimple: () => {
          seen.push(inSubCall());
          const s = createAssistantMessageEventStream();
          queueMicrotask(() => s.end());
          return s;
        },
      } as any);
      const model = registry.find('probe', 'm')!;
      expect(model).toBeDefined();

      await runAsSubCall(() => drain(runtime.streamSimple(model, { messages: [] } as any, {})));
      await drain(runtime.streamSimple(model, { messages: [] } as any, {}));

      expect(seen).toEqual([true, false]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanity: the store really is per call chain (two interleaved scopes do not see each other)', async () => {
    const als = new AsyncLocalStorage<string>();
    const out: string[] = [];
    await Promise.all(
      ['a', 'b'].map((id) =>
        als.run(id, async () => {
          await new Promise((r) => setTimeout(r, id === 'a' ? 5 : 1));
          out.push(`${id}:${als.getStore()}`);
        })
      )
    );
    expect(out.sort()).toEqual(['a:a', 'b:b']);
  });
});
