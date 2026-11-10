// src/integration.ts
// The contract every optional external component (Laya today, CodexBar next)
// is wired in through (docs/plans/2026-11-08-optional-integrations-config.md,
// Solution 1): one base config shape, one validator, one health registry.
//
// Fail-safe, never loud: validation runs at extension start and mid-turn from
// tools, so a bad block disables the integration (enabled:false) with a
// warning instead of throwing and taking the router down.

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
  if (!block?.enabled) return;
  const disable = (why: string): void => {
    warnLog(`[router] ${spec.label}: ${why} — integration disabled (enabled:false)`);
    block.enabled = false;
  };
  const extra = spec.validateExtra?.(block);
  if (extra) {
    disable(extra);
    return;
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
