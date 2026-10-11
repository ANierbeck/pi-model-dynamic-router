// src/utils.ts
// Utility functions for the pi-model-router

import { STRIP_SUFFIXES, PARAM_SUFFIXES } from './providers.ts';
import type { ModelRef } from './types.ts';

// ── String Utilities ──────────────────────────────────────────────────────

/**
 * Normalizes a string for comparison
 */
function stripDateSuffix(s: string): string {
  // Strip trailing date/version tags: -YYYYMMDD, -YYMMDD, -YYMM (e.g., -20250514, -2507, -0324)
  return s.replace(/-\d{4,8}$/, '');
}
export function norm(s: string): string {
  s = s.toLowerCase();
  // Strip to last path segment — "chutes/deepseek-ai/DeepSeek-V3" → "deepseek-v3"
  const slash = s.lastIndexOf('/');
  if (slash !== -1 && slash < s.length - 1) s = s.slice(slash + 1);
  for (const x of STRIP_SUFFIXES) s = s.replace(x, '');
  s = stripDateSuffix(s);
  return s.replace(/[^a-z0-9]/g, '');
}

/**
 * Removes date suffixes from model IDs (e.g. -20250514, -2507, -0324)
 */

/**
 * Splits a model reference into provider and model ID
 */
export function splitRef(ref: string): ModelRef {
  const i = ref.indexOf('/');
  return i === -1
    ? { provider: ref, modelId: ref }
    : { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/**
 * Formats numbers for display (e.g. 1000 → "1k")
 */
export function fmt(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

/**
 * Formats time durations for display
 */
export function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60),
    rs = s % 60;
  if (m < 60) return `${m}m${rs ? rs + 's' : ''}`;
  return `${Math.floor(m / 60)}h${m % 60 ? (m % 60) + 'm' : ''}`;
}

/**
 * pushRouterInfo/pushRouterInfoLogged (src/stream-driver.ts) prepend lines
 * like "> [router] HINT: mistral/foo · mistral/foo\n\n" to the assistant's
 * VISIBLE response before the model's real text. Those lines end up stored in
 * context.messages, so any text extracted from message history for the
 * classifier must have them stripped first — otherwise the narration's own
 * literal "HINT: <model>" substring gets misread as a fresh user-issued HINT,
 * creating a self-reinforcing lock-in loop. This must run on every extraction
 * path that feeds classifier input (last user prompt, last assistant
 * snippet, previous user message), not just one of them: a subagent task
 * that replays prior turns verbatim (e.g. wrapped in "<conversation>...")
 * carries old narration lines anywhere in its body, not only at the start.
 * Delegation/bulk-read sub-call output goes through the same function, so
 * blank-line runs left by removed lines are collapsed too.
 */
export function stripRouterNarration(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^>\s*\[router\]/.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Whether `text` is exactly one memory-extension context block
 * (`<memory>\n…\n</memory>`, customType "pi-memory-context").
 *
 * The memory extension injects that block as its own message directly before
 * every real user prompt, and Pi hands it to providers as `role: 'user'`.
 * It is background context, never something the user said — so it must not
 * count as the "previous user message" (live: 112 of 131 classifier-decision
 * records, 85 %, carried the block there) nor as the request itself.
 * Deliberately strict: a real message that merely mentions the tag, or that
 * carries text around a block, is a user message. Pi's convertToLlm drops the
 * customType, so this shape is the only signal available to the router — use
 * it only where a false positive is harmless (the "previous message" context
 * line), never to discard the current request.
 */
export function isMemoryContextText(text: string): boolean {
  const t = text.trim();
  return t.startsWith('<memory>') && t.endsWith('</memory>');
}

/** Plain text of a message `content` (string, or the text blocks of a block array). */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text as string)
      .join('');
  }
  return '';
}

/** The `role: 'user'` messages that are real user turns (memory-extension blocks excluded). */
export function realUserMessages<T extends { role?: string; content?: unknown }>(messages: readonly T[]): T[] {
  return messages.filter((m) => m.role === 'user' && !isMemoryContextText(messageText(m.content)));
}

// ── Model Token Utilities ─────────────────────────────────────────────────

/**
 * Extract base tokens from a model ID
 * Removes parameter suffixes, date suffixes and splits into sorted tokens
 */
export function baseTokens(s: string): Set<string> {
  s = s.toLowerCase();
  const slash = s.lastIndexOf('/');
  if (slash !== -1 && slash < s.length - 1) s = s.slice(slash + 1);
  for (const ps of PARAM_SUFFIXES) s = s.replace(ps, '');
  for (const x of STRIP_SUFFIXES) s = s.replace(x, '');
  s = stripDateSuffix(s);
  return new Set(s.match(/[a-z]+|\d+/g) ?? []);
}

// ── HINT Resolution Utilities ─────────────────────────────────────────────

/**
 * Resolves a short model name (e.g. "mistral-medium-3.5") to a fully-qualified
 * "provider/model" ref by searching group models lists.
 * - Already-qualified refs (contain '/') are returned unchanged.
 * - Returns null when the short name is not found in any group, so callers can
 *   distinguish a genuine lookup miss from a successful exact-match resolution.
 */
/**
 * Normalizes a model hint target for second-chance matching: lowercase,
 * dots and underscores mapped to dashes, collapsed repeats (2026-09-20
 * HINT-targeting regression incident — `zai-glm-5.3` / `zai-glm-5_3`
 * must resolve to `zai-glm-5-3`). Exact matching always runs FIRST; this
 * normalization only fires as a fallback so registry ids that genuinely
 * contain dots (e.g. `mistral-medium-3.5`) keep their exact-match priority.
 */
export function normalizeHintName(name: string): string {
  return name.toLowerCase().replace(/[._\s]+/g, '-').replace(/-+/g, '-');
}

/**
 * Whether a bare hint target matches a "provider/modelId" ref — exact id
 * equality first, then separator-normalized equality (both sides), so
 * `zai-glm-5.3` matches `mistral/zai-glm-5-3` but `zai-glm-5-2` never
 * matches `zai-glm-5-3`.
 */
export function hintTargetMatches(target: string, ref: string): boolean {
  const modelId = ref.includes('/') ? ref.slice(ref.lastIndexOf('/') + 1) : ref;
  if (modelId === target || ref === target) return true;
  return normalizeHintName(modelId) === normalizeHintName(target);
}

export function resolveShortModelName(
  target: string,
  allDiscoveredRefs: string[]
): string | null {
  if (target.includes('/')) return target;
  // Exact match keeps first priority — never regress exact lookups.
  const match = allDiscoveredRefs.find(
    (m: string) => m === target || m.endsWith('/' + target) || m.split('/').pop() === target
  );
  if (match) return match;
  // Second chance: separator-normalized comparison (dot/underscore/case
  // variants of the same model name resolve to the same model).
  const normalized = normalizeHintName(target);
  const fuzzyMatch = allDiscoveredRefs.find(
    (m: string) => normalizeHintName(m.split('/').pop() ?? m) === normalized
  );
  return fuzzyMatch || null;
}



/**
 * Wraps an async function so its runs never overlap: each call starts after
 * the previous one settled (resolved or rejected). Every caller still gets
 * its own run's result or error.
 */
export function serialized<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return (...args: A) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };
}
