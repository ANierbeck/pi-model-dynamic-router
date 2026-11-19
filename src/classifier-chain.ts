// src/classifier-chain.ts
// The classifier chain the current config produces (config plan
// 2026-11-14, Phases 2 and 5). The order is fixed in code (see
// `classifyViaLlmChain` in content-classifier.ts): Laya, then the local Ollama
// leg, then the cloud leg, then the static rules. The config only switches
// legs on and off and names their models. The ids below are the step names
// the routing-flow diagram and the generated reference pin.

import type { Config } from './types.ts';

export type ClassifierChainStepId = 'laya' | 'ollama' | 'cloud' | 'static';

export interface ClassifierChainStep {
  id: ClassifierChainStepId;
  label: string;
  /** Whether the config switches this leg on. */
  active: boolean;
  /** One line: what the leg does with the current config (on/off is `active`, not repeated here). */
  detail: string;
}

/** The steps in the order the router runs them. */
export function describeClassifierChain(cfg: Config): ClassifierChainStep[] {
  const laya = cfg.integrations?.laya;
  const layaOn = laya?.enabled === true;
  const layaDetail = !layaOn
    ? 'integration not enabled'
    : laya?.mode === 'active'
      ? 'active: a valid answer decides'
      : 'shadow: log only, the route does not change';

  const local = cfg.classifier?.local;
  const ollamaDetail = local?.model
    ? `pinned ${local.model}${local.fallback ? `, then ${local.fallback}` : ''}`
    : 'models derived from what Ollama reports';

  const cloud = cfg.classifier?.cloud;
  const cloudOn = cloud?.enabled === true;
  const candidates = cloud?.candidates ?? [];
  const cloudParts: string[] = [];
  if (!cloudOn) {
    cloudParts.push('prompt text stays on this machine');
  } else {
    cloudParts.push(
      cloud?.escalate_low_confidence === true
        ? 'when local gives no answer or a low-confidence one'
        : 'when local gives no answer'
    );
    // A pin goes first in front of any list, the configured one included
    // (classifyViaLlmChain in content-classifier.ts).
    const pinFirst = cloud?.model ? `pinned ${cloud.model} first, then ` : '';
    if (candidates.length > 0) {
      cloudParts.push(`${pinFirst}${candidates.length} configured, replaces the automatic chain`);
    } else if (cloud?.model) {
      cloudParts.push(`pinned ${cloud.model} first, then the probe-verified list`);
    } else {
      cloudParts.push('probe-verified list');
    }
  }

  return [
    { id: 'laya', label: 'Laya', active: layaOn, detail: layaDetail },
    { id: 'ollama', label: 'Local (Ollama)', active: true, detail: ollamaDetail },
    { id: 'cloud', label: 'Cloud', active: cloudOn, detail: cloudParts.join('; ') },
    {
      id: 'static',
      label: 'Static rules',
      active: false,
      detail: 'only for the :use-static model variant; not set by the config',
    },
  ];
}

/** The chain as indented lines for a reply or a status view. */
export function formatClassifierChain(steps: ClassifierChainStep[]): string[] {
  return steps.map((s) => `  ${s.label}: ${s.active ? 'on' : 'off'} — ${s.detail}`);
}
