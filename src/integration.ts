// src/integration.ts
// The contract every optional external component (Laya today, CodexBar next)
// is wired in through (docs/plans/2026-11-08-optional-integrations-config.md,
// Solution 1): one base config shape, one validator, one health registry.
//
// Fail-safe, never loud: validation runs at extension start and mid-turn from
// tools, so a bad block disables the integration (enabled:false) with a
// warning instead of throwing and taking the router down.

import { sanitizeForLog } from './detection.ts';
import { closestKey } from './config-schema.ts';
import { warnLog } from './logger.ts';

/** The shape shared by every integration block; specific fields live next to it. */
export interface IntegrationConfig {
  /** Default false. An integration that is not there leaves the core chain in charge. */
  enabled?: boolean;
  mode?: string;
  /** Base URL of the local sidecar; must be loopback. */
  endpoint?: string;
  timeout_ms?: number;
}

/** The keys every integration block may carry; a spec adds its own via `extraKeys`. */
export const BASE_INTEGRATION_KEYS = ['enabled', 'mode', 'endpoint', 'timeout_ms'] as const;

/** What an integration declares about itself. */
export interface IntegrationSpec {
  /** Config key under `integrations`, e.g. `laya`. */
  name: string;
  /** Prefix of every warning, e.g. `integrations.laya`. */
  label: string;
  /** Modes this integration accepts. */
  modes: readonly string[];
  defaultMode: string;
  defaultTimeoutMs: number;
  defaultEndpoint: string;
  /** Integration-specific keys (known to the unknown-key check). */
  extraKeys?: readonly string[];
  /**
   * Validate or default the integration-specific fields (mutating `block`).
   * Returns a reason when the problem is fatal: the integration is disabled.
   */
  validateExtra?: (block: Record<string, unknown>) => string | undefined;
}

/**
 * A key for a log line: JSON-quoted, so newlines and terminal escapes in a
 * hostile config key cannot forge log entries or move the cursor.
 */
export function jsonKey(key: string): string {
  return JSON.stringify(key);
}

// A config problem is reported once until it changes: load() runs again from
// tools and commands mid-turn, and the same typo must not refill the log.
const lastWarned = new Map<string, string>();

/** Warn unless the last warning under `key` was this very message. */
export function warnOnceFor(key: string, message: string): void {
  if (lastWarned.get(key) === message) return;
  lastWarned.set(key, message);
  warnLog(message);
}

/** The problem under `key` is gone; if it comes back, it is reported again. */
export function forgetWarnOnce(key: string): void {
  lastWarned.delete(key);
}

/** Forget every remembered warning (tests). */
export function resetWarnOnce(): void {
  lastWarned.clear();
}

/** Hostnames the router will send prompt text to: this machine only. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Validate one integration block in place. A disabled or absent block is left
 * alone. On `enabled: true` the base fields are checked (loopback endpoint,
 * mode, timeout) and defaulted; a wrong-typed field falls back to its default
 * with one warning; a fatal problem sets `enabled: false`.
 */
export function validateIntegration(spec: IntegrationSpec, block: Record<string, unknown>): void {
  if (!block || typeof block !== 'object') return;
  warnUnknownFields(spec, block);
  if (!block.enabled) return;
  const disable = (why: string): void => {
    warnLog(`[router] ${spec.label}: ${why} — integration disabled (enabled:false)`);
    block.enabled = false;
  };
  if (typeof block.enabled !== 'boolean') {
    // "false" is truthy: an enabled-looking string must not switch a sidecar on.
    disable(`'enabled' must be true or false, not ${JSON.stringify(block.enabled)}`);
    return;
  }
  const extra = spec.validateExtra?.(block);
  if (extra) {
    disable(extra);
    return;
  }
  if (block.endpoint != null && typeof block.endpoint !== 'string') {
    warnLog(
      `[router] ${spec.label}: invalid endpoint ${JSON.stringify(block.endpoint)} — falling back to ${spec.defaultEndpoint}`
    );
    block.endpoint = spec.defaultEndpoint;
  }
  const endpoint = (block.endpoint as string | undefined) ?? spec.defaultEndpoint;
  let hostname: string;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
    hostname = u.hostname;
  } catch {
    disable(`endpoint ${JSON.stringify(endpoint)} is not a valid http(s) URL`);
    return;
  }
  if (!isLoopbackHost(hostname)) {
    disable(
      `endpoint host ${JSON.stringify(hostname)} is not loopback — the router only sends ` +
        `prompts to 127.0.0.0/8, localhost or ::1`
    );
    return;
  }
  if (block.mode != null && !spec.modes.includes(block.mode as string)) {
    warnLog(
      `[router] ${spec.label}: invalid mode ${JSON.stringify(block.mode)} — falling back to "${spec.defaultMode}"`
    );
    block.mode = spec.defaultMode;
  }
  const t = block.timeout_ms;
  if (t != null && (typeof t !== 'number' || !(t > 0))) {
    warnLog(
      `[router] ${spec.label}: invalid timeout_ms ${JSON.stringify(t)} — falling back to ${spec.defaultTimeoutMs}`
    );
    block.timeout_ms = spec.defaultTimeoutMs;
  }
  block.endpoint ??= spec.defaultEndpoint;
  block.timeout_ms ??= spec.defaultTimeoutMs;
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall through
  if (!block.mode) block.mode = spec.defaultMode;
}

/** A misspelled field (`endpint`, `enabld`) would otherwise be ignored without a word. */
function warnUnknownFields(spec: IntegrationSpec, block: Record<string, unknown>): void {
  const known: readonly string[] = [...BASE_INTEGRATION_KEYS, ...(spec.extraKeys ?? [])];
  const unknown = Object.keys(block).filter(
    (k) => !k.startsWith('_') && !k.startsWith('$') && !known.includes(k)
  );
  const onceKey = `${spec.label}:unknown`;
  if (unknown.length === 0) {
    forgetWarnOnce(onceKey);
    return;
  }
  const described = unknown.map((k) => {
    const near = closestKey(k, known);
    return near ? `${jsonKey(k)} (did you mean "${near}"?)` : jsonKey(k);
  });
  warnOnceFor(onceKey, `[router] ${spec.label}: unknown key(s) ${described.join(', ')} — ignored`);
}

// ── Health registry ────────────────────────────────────────────────────────

/** `unknown` is "not probed yet", not a failure. */
export interface IntegrationHealth {
  state: 'ok' | 'down' | 'unknown';
  /** Why it is down (already masked by the caller). */
  lastError?: string;
  /** Version the sidecar reported on /health. */
  version?: string;
  /** Epoch ms of the last successful probe. */
  lastOkAt?: number;
  /** Epoch ms until which this entry is trusted; afterwards it reads as `unknown` (re-probe). */
  until?: number;
}

const health = new Map<string, IntegrationHealth>();

export function setIntegrationHealth(name: string, entry: IntegrationHealth): void {
  health.set(name, entry);
}

export function getIntegrationHealth(name: string): IntegrationHealth {
  const entry = health.get(name);
  if (!entry || (entry.until !== undefined && Date.now() > entry.until))
    return { state: 'unknown' };
  return entry;
}

/** Forget one integration's health, or all of them. */
export function resetIntegrationHealth(name?: string): void {
  if (name === undefined) health.clear();
  else health.delete(name);
}

/**
 * Plain lines for every KNOWN integration, configured or not, so a switched-off
 * one stays visible with its last health and the way to switch it on. A
 * configured name that is not known is reported, never ignored.
 */
export function formatIntegrationLines(
  configured: Record<string, unknown>,
  specs: Readonly<Record<string, IntegrationSpec>>
): string[] {
  const lines: string[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    const block = configured[name] as
      | { enabled?: unknown; mode?: unknown; endpoint?: unknown }
      | undefined;
    if (block?.enabled !== true) {
      lines.push(`${name}: off — switch on: /router config integration ${name} on`);
      if (getIntegrationHealth(name).state !== 'unknown') {
        lines.push(`  last probe: ${healthText(name)}`);
      }
      continue;
    }
    const mode = typeof block.mode === 'string' ? block.mode : spec.defaultMode;
    lines.push(`${name}: on (${mode})`);
    const endpoint = typeof block.endpoint === 'string' ? block.endpoint : spec.defaultEndpoint;
    lines.push(`  endpoint ${displayEndpoint(endpoint)} · ${healthText(name)}`);
  }
  for (const key of Object.keys(configured)) {
    if (!Object.hasOwn(specs, key) && !key.startsWith('_') && !key.startsWith('$')) {
      lines.push(`"${key}" is not a known integration (ignored)`);
    }
  }
  return lines;
}

/** Health for the status line. Sidecar-supplied text is sanitized and bounded before it is shown. */
function healthText(name: string): string {
  const h = getIntegrationHealth(name);
  if (h.state === 'ok') {
    return `reachable (${h.version ? sanitizeForLog(h.version) : 'no version reported'})`;
  }
  if (h.state === 'down') {
    const parts = [
      h.version ? `last served ${sanitizeForLog(h.version)}` : '',
      h.lastError ? sanitizeForLog(h.lastError).slice(0, 160) : '',
    ].filter(Boolean);
    return `unreachable${parts.length ? ` (${parts.join(', ')})` : ''}`;
  }
  return 'not probed yet (probes on first use)';
}

/** The endpoint without URL credentials: a `user:password@` in a config file is never printed back. */
function displayEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (!url.username && !url.password) return endpoint;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return sanitizeForLog(endpoint);
  }
}

/**
 * Why a switch patch is refused, or undefined when it is fine. Enabled must be
 * a real boolean (the string "false" is truthy); the mode must be one the
 * integration accepts.
 */
export function checkIntegrationPatch(
  spec: IntegrationSpec,
  patch: { enabled?: unknown; mode?: string }
): string | undefined {
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    return 'enabled must be true or false';
  }
  if (patch.mode !== undefined && !spec.modes.includes(patch.mode)) {
    return `mode "${patch.mode}" is not one of ${spec.modes.join(', ')}`;
  }
  return undefined;
}
