/**
 * worker_step (long-turn plan Phase 2,
 * docs/plans/2026-11-21-long-turn-model-use.md): hand a fully specified
 * MECHANICAL task to the cheap delegation group as a text-only sub-call.
 *
 * Phase 0 (docs/research/2026-11-21-long-turn-profile.md) measured that 83 %
 * of steps in long turns are mechanical and that the expensive models spend
 * 86 % of their long-turn steps on such steps — the saving is in the NUMBER
 * of expensive steps, so this tool lets the orchestrating model replace a
 * run of expensive mechanical steps (interpreting a log, filtering output,
 * checking a diff) with one cheap sub-call.
 *
 * The worker has NO tools (streamSimple is text-only), so the contract is
 * text work over material the orchestrator already has in its context —
 * never "run these commands". The model is derived from the configured
 * delegation group (ADR-0025: no model is named here).
 */

import { delegationSettings, drainSubCallStream } from './delegation.ts';
import type { Config } from './types.ts';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Usage } from '@earendil-works/pi-ai';

/** Cap of the task text passed to the worker (protects the sub-call prompt). */
export const WORKER_TASK_MAX_CHARS = 20_000;

export function buildWorkerPrompt(task: string): string {
  return (
    'You are a worker sub-model of a coding agent. Complete the MECHANICAL task below ' +
    'over the material given in it. You have no tools: do not claim to have run commands. ' +
    'Return only the result — terse, structured, no preamble, no offers to help further.\n\n' +
    `TASK:\n${task}`
  );
}

export interface WorkerStepResult {
  content: Array<{ type: 'text'; text: string }>;
  usage?: Usage;
}

/**
 * Run one worker step. Fails closed (throws) on every misconfiguration —
 * the tool surfaces that to the calling model, which can then do the step
 * itself.
 */
export async function runWorkerStep(
  task: string,
  ctx: ExtensionContext | null | undefined,
  cfg: Config | undefined,
  log?: (msg: string) => void
): Promise<WorkerStepResult> {
  const settings = delegationSettings(cfg);
  if (!settings.enabled) {
    throw new Error('worker_step is disabled (delegation.enabled is off) — do the step yourself');
  }
  if (typeof task !== 'string' || task.trim().length === 0) {
    throw new Error('worker_step needs a non-empty task');
  }
  if (task.length > WORKER_TASK_MAX_CHARS) {
    throw new Error(
      `worker_step task too long (${task.length} > ${WORKER_TASK_MAX_CHARS} chars) — split it or do it yourself`
    );
  }
  const model = ctx?.modelRegistry?.find(settings.group, settings.group);
  if (!ctx || !model) {
    throw new Error(`worker group "${settings.group}" is not registered — do the step yourself`);
  }
  const context = {
    messages: [{ role: 'user' as const, content: buildWorkerPrompt(task), timestamp: Date.now() }],
  };
  // Same registry reach-through as the delegation handler (verified against
  // the host; see src/delegation.ts).
  const registryRuntime = (
    ctx.modelRegistry as unknown as {
      runtime: { streamSimple: typeof ctx.modelRegistry.streamSimple };
    }
  ).runtime;
  const stream = registryRuntime.streamSimple(
    model,
    context,
    ctx.signal !== undefined ? { signal: ctx.signal } : undefined
  );
  const { text, usage } = await drainSubCallStream(stream);
  log?.(
    `[worker] ${task.length}-char task answered by ${settings.group} (${text.length} chars out)`
  );
  const result: WorkerStepResult = { content: [{ type: 'text', text }] };
  if (usage) result.usage = usage;
  return result;
}
