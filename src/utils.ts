// src/utils.ts
// Utility functions for the pi-model-router

import { STRIP_SUFFIXES, PARAM_SUFFIXES } from './providers.js';
import type { ModelRef } from './types.js';

// ── String Utilities ──────────────────────────────────────────────────────

/**
 * Normalizes a string for comparison
 */
export function stripDateSuffix(s: string): string {
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
 * Removes the provider prefix from a reference
 * Example: "chutes/deepseek-ai/DeepSeek-V3" → "deepseek-ai/DeepSeek-V3"
 */
export function stripProvider(ref: string): string {
  const i = ref.indexOf('/');
  if (i === -1) return ref;
  const prov = ref.slice(0, i);
  // If the provider exists in PROVIDER_MAP or cfg.providers, remove it
  // For this function we pass the provider list in later
  return ref.slice(i + 1);
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
export function resolveShortModelName(
  target: string,
  modelGroups: Record<string, { models?: string[] }>
): string | null {
  if (target.includes('/')) return target;
  for (const groupConfig of Object.values(modelGroups)) {
    const match = groupConfig.models?.find(
      (m) => m.endsWith('/' + target) || m === target
    );
    if (match) return match;
  }
  return null;
}

// ── Validation Utilities ──────────────────────────────────────────────────

/**
 * Checks whether a model reference is currently rate-limited
 */
export function isModelLimited(
  ref: string,
  limits: Map<string, { cooldown_until: number }>
): boolean {
  const limit = limits.get(ref);
  if (!limit) return false;
  if (Date.now() >= limit.cooldown_until) {
    limits.delete(ref);
    return false;
  }
  return true;
}

/**
 * Returns the remaining seconds of the rate limit
 */
export function limitSecs(ref: string, limits: Map<string, { cooldown_until: number }>): number {
  const limit = limits.get(ref);
  return limit ? Math.max(0, Math.ceil((limit.cooldown_until - Date.now()) / 1000)) : 0;
}
