// describeClassifierChain(cfg) (config plan 2026-11-14, Phase 2 and 5): the
// ordered steps the current config produces. The order is fixed in code
// (Laya, local Ollama, cloud, static rules); the config only switches steps
// on and off and names their models. The step ids are pinned here because the
// routing-flow diagram and the generated reference use them.

import { describe, it, expect } from 'vitest';
import { describeClassifierChain } from '../src/classifier-chain.ts';
import type { Config } from '../src/types.ts';

const base = (over: Partial<Config> = {}): Config =>
  ({ model_groups: {}, ...over }) as unknown as Config;

const stepOf = (steps: ReturnType<typeof describeClassifierChain>, id: string) => {
  const step = steps.find((s) => s.id === id);
  if (!step) throw new Error(`no step ${id}`);
  return step;
};

describe('describeClassifierChain', () => {
  it('lists the four legs in the fixed order, with the step ids the docs pin', () => {
    const steps = describeClassifierChain(base());
    expect(steps.map((s) => s.id)).toEqual(['laya', 'ollama', 'cloud', 'static']);
  });

  it('shows Laya off when the integration is not enabled', () => {
    expect(stepOf(describeClassifierChain(base()), 'laya').active).toBe(false);
  });

  it('shows Laya as deciding only in active mode, and as log-only in shadow mode', () => {
    const active = describeClassifierChain(
      base({ integrations: { laya: { enabled: true, mode: 'active' } } } as Partial<Config>)
    );
    expect(stepOf(active, 'laya')).toMatchObject({ active: true });
    expect(stepOf(active, 'laya').detail).toMatch(/decides/);

    const shadow = describeClassifierChain(
      base({ integrations: { laya: { enabled: true, mode: 'shadow' } } } as Partial<Config>)
    );
    expect(stepOf(shadow, 'laya').detail).toMatch(/log only/);
  });

  it('shows the cloud leg off, and says prompts stay local, when cloud is disabled', () => {
    const steps = describeClassifierChain(
      base({ classifier: { cloud: { enabled: false } } } as Partial<Config>)
    );
    expect(stepOf(steps, 'cloud')).toMatchObject({ active: false });
    expect(stepOf(steps, 'cloud').detail).toMatch(/stays on this machine/);
  });

  it('names the user list when candidates are configured, and says it replaces the automatic chain', () => {
    const steps = describeClassifierChain(
      base({
        classifier: { cloud: { enabled: true, candidates: ['acme/a', 'acme/b'] } },
      } as Partial<Config>)
    );
    expect(stepOf(steps, 'cloud')).toMatchObject({ active: true });
    expect(stepOf(steps, 'cloud').detail).toMatch(/2 configured/);
    expect(stepOf(steps, 'cloud').detail).toMatch(/replaces the automatic/);
  });

  it('says a pinned cloud model still goes first when candidates are configured', () => {
    // content-classifier puts the pin at position 0 of whatever list it tries,
    // the configured candidates included.
    const steps = describeClassifierChain(
      base({
        classifier: { cloud: { enabled: true, model: 'acme/p', candidates: ['acme/a'] } },
      } as Partial<Config>)
    );
    expect(stepOf(steps, 'cloud').detail).toMatch(/pinned acme\/p first, then 1 configured/);
  });

  it('leaves on/off to the step state: no detail repeats it', () => {
    const configs = [
      base(),
      base({ classifier: { cloud: { enabled: true } } } as Partial<Config>),
      base({ classifier: { cloud: { enabled: false } } } as Partial<Config>),
    ];
    for (const cfg of configs) {
      for (const step of describeClassifierChain(cfg)) {
        expect(step.detail, step.id).not.toMatch(/^(on|off)\b/);
      }
    }
  });

  it('says a cloud leg escalates only low-confidence local replies when that is configured', () => {
    const steps = describeClassifierChain(
      base({
        classifier: { cloud: { enabled: true, escalate_low_confidence: true } },
      } as Partial<Config>)
    );
    expect(stepOf(steps, 'cloud').detail).toMatch(/low-confidence/);
  });

  it('shows the pinned local model in the ollama step', () => {
    const steps = describeClassifierChain(
      base({ classifier: { local: { model: 'ollama/judge:1b' } } } as Partial<Config>)
    );
    expect(stepOf(steps, 'ollama')).toMatchObject({ active: true });
    expect(stepOf(steps, 'ollama').detail).toMatch(/judge:1b/);
  });
});
