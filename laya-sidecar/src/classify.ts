// The classifier the sidecar serves: one Laya model directory, one head, one state layout.
// The state layout mirrors build_state in spikes/laya-http/server.py (train/serve parity).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, type QuestionDef } from './laya/agent.js';
import type { Head } from './identity.js';

export interface ClassifyContext {
  previousUserMessage?: string;
  lastAssistantSnippet?: string;
}

export interface Classification {
  category: string;
  confidence: number;
  probabilities: Record<string, number>;
  ms: number;
}

/** Files a model directory must contain before the runtime is touched (no network fallback). */
export const REQUIRED_FILES = [
  'encoder.onnx',
  'head.onnx',
  'tokenizer.json',
  'rl_agent_config.json',
] as const;

export function buildState(prompt: string, context?: ClassifyContext | null): string {
  const lines: string[] = [];
  if (context?.previousUserMessage) {
    lines.push(`Previous user message: "${context.previousUserMessage.slice(0, 120)}"`);
  }
  if (context?.lastAssistantSnippet) {
    lines.push(
      `Last assistant response (excerpt): "${context.lastAssistantSnippet.slice(0, 150)}"`
    );
  }
  const head = lines.length ? `Context (background only):\n${lines.join('\n')}\n\n` : '';
  return `${head}Current request: "${prompt}"`;
}

export interface Classifier {
  classify(prompt: string, context?: ClassifyContext | null): Promise<Classification>;
}

/**
 * Load the model from a local directory. The directory is checked first: laya-ts falls back to a
 * Hugging Face download when a local path is missing, and the sidecar must never download.
 */
export async function openClassifier(modelDir: string, head: Head): Promise<Classifier> {
  for (const f of REQUIRED_FILES) {
    if (!existsSync(join(modelDir, f))) {
      throw new Error(
        `model directory ${modelDir} is incomplete: ${f} missing (nothing is downloaded)`
      );
    }
  }
  const agent = await Agent.load(modelDir, { localDir: modelDir });
  const question: Record<string, QuestionDef> = {
    category: {
      type: 'choice',
      instructions: head.instructions,
      criteria: head.categories,
    } as QuestionDef,
  };
  // Warm-up pass, as in server.py: the first call pays one-off allocation costs.
  await agent.predict(buildState('warmup'), question);
  return {
    async classify(prompt, context) {
      const t = performance.now();
      const res = await agent.predict(buildState(prompt, context), question);
      const ans = (
        res as unknown as {
          answers: {
            category: {
              choice: string;
              answer_confidence: number;
              probabilities: Record<string, number>;
            };
          };
        }
      ).answers.category;
      return {
        category: ans.choice,
        confidence: ans.answer_confidence,
        probabilities: ans.probabilities,
        ms: Math.round((performance.now() - t) * 100) / 100,
      };
    },
  };
}
