// src/discovery.ts
// Provider and model discovery for the pi-model-router

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

import type { Config, Cache, ProviderConfig, ProviderKey } from './types.ts';
import { PROVIDER_MAP } from './providers.ts';

// NOTE (2026-09-02): the hardcoded CURATED_FREE_MODELS list that used to live
// here has been REMOVED. It only worked for one user's provider setup (a user
// with mistral-zai/mistral-small-latest configured); every other user got a
// list of models they couldn't use. It has been replaced by a dynamic,
// probe-based discovery in src/classifier-fallback-probe.ts:
//   1. selectClassifierCandidates() picks cheap + low-gdpval candidates
//      from the scan cache (works for ANY user's providers).
//   2. probeAndCache() pings each candidate at scan time and caches the
//      verified-working ones in cache.classifier_fallback_models.
//   3. The classifier reads that cached list at fallback time.
// getCheapestCloudModels() was also removed (dead code: no production callers
// after the classifier moved to the probe-based path). Its pricing-lookup
// logic is now covered by test/classifier-fallback-probe.test.ts.

// ── Constants ────────────────────────────────────────────────────────────

const AUTH_PATH = path.join(homedir(), '.pi', 'agent', 'auth.json');
// ── Key-reference resolution (single source of truth) ────────────────────
//
// A provider key entry's `.key` field may be either a raw secret (legacy /
// env-only setups) or a resolvable reference marker produced by
// discoverKeys():
//   !pass show <path>            -> pass store lookup
//   __cli_oauth__:<file>:<field> -> read a field from a CLI OAuth json file
//   __auth_json__:<authKey>      -> read from ~/.pi/agent/auth.json (this is
//                                 how auth.json-sourced keys are stored so
//                                 the raw secret is never serialized into
//                                 the tracked router-config.json)
//   __oauth__:<authKey>          -> same as __auth_json__, legacy marker name
//   __local__                    -> the literal string 'local' (Ollama)
//   <ENV_VAR_NAME>               -> process.env lookup (only when the string
//                                 isn't any of the above markers)
//
// This used to be duplicated across DiscoveryManager, BudgetTracker, and
// local-llm.ts with slightly different marker coverage in each -- which is
// exactly how the __auth_json__ marker (added when auth.json keys stopped
// being stored raw for security) failed to propagate to local-llm.ts,
// silently disabling its free-model cloud fallback for auth.json-only
// providers. Consolidating into one pure function removes that drift.

export interface AuthEntry {
  key?: string;
  access?: string;
}
export type AuthData = Record<string, AuthEntry> | null;

/**
 * Reads ~/.pi/agent/auth.json (the single auth source used by the
 * __auth_json__ / __oauth__ markers). Returns {} on any read/parse error so
 * callers can treat a missing/unreadable auth file as "no auth entries".
 */
export function loadAuthFile(): AuthData {
  try {
    return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Pure key-reference resolver. Returns the resolved secret, or null when
 * the marker is known but cannot be resolved (missing pass entry, unreadable
 * file, no matching auth entry). Returning null -- rather than the marker
 * itself -- lets callers skip the provider instead of issuing a request with
 * an unusable bearer token that will fail auth and be silently swallowed.
 *
 * `auth` is passed in (rather than read here) so callers control when the
 * file is read and can inject a mock in tests.
 *
 * For a non-marker, non-env string (a legacy raw key) the key is returned
 * as-is so direct keys still work; callers that want "skip on unknown" can
 * null-check the result.
 */
export function resolveKeyRef(key: string, auth: AuthData): string | null {
  if (key.startsWith('!pass show ')) {
    try {
      const out = execSync(key.slice(1) + ' 2>/dev/null', { encoding: 'utf-8' }).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  if (key.startsWith('__cli_oauth__:')) {
    const parts = key.slice('__cli_oauth__:'.length);
    const lastColon = parts.lastIndexOf(':');
    const filePath = parts.slice(0, lastColon).replace('~', homedir());
    const field = parts.slice(lastColon + 1);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return data[field] ?? null;
    } catch {
      return null;
    }
  }

  if (key.startsWith('__auth_json__:') || key.startsWith('__oauth__:')) {
    const authKey = key.startsWith('__auth_json__:')
      ? key.slice('__auth_json__:'.length)
      : key.slice('__oauth__:'.length);
    const entry = auth?.[authKey];
    if (entry?.key) return entry.key;
    if (entry?.access) return entry.access;
    return null;
  }

  if (key === '__local__') {
    return 'local';
  }

  // Environment variable: only when the string isn't one of the markers
  // above (otherwise an env var named like, say, "__local__" would shadow
  // the marker -- unlikely, but the marker check must come first).
  if (process.env[key]) {
    return process.env[key]!;
  }

  // Raw key (no marker, no env match) -- return as-is so legacy direct keys
  // still work.
  return key;
}


// ── Discovery Manager ─────────────────────────────────────────────────────

/**
 * Manages discovery of API keys and models
 */
export class DiscoveryManager {
  private cfg: Config;
  private cache: Cache;
  private passEntries: string[] | null = null;
  private discoveredProviders = new Set<string>();

  constructor(cfg: Config, cache: Cache) {
    this.cfg = cfg;
    this.cache = cache;
  }

  // ── Key Discovery ───────────────────────────────────────────────────────

  /**
   * Loads PI's auth file
   */
  loadAuth(): any {
    return loadAuthFile();
  }

  /**
   * Saves PI's auth file
   */
  saveAuth(auth: any): void {
    fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
  }

  /**
   * Parses pass store entries
   */
  parsePassTree(): string[] {
    if (this.passEntries !== null) return this.passEntries;

    try {
      // Redirect stderr to suppress "pass not found" errors
      const raw = execSync('pass ls 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
      const lines = raw.split('\n');
      const stack: string[] = [];
      const entries: string[] = [];

      for (let line of lines) {
        // Strip ANSI escape codes (colors from pass ls output)
        line = line.replace(/\x1b\[[0-9;]*m/g, '');
        if (line === 'Password Store' || !line.trim()) continue;

        // Determine depth by counting tree prefixes
        const stripped = line.replace(/[│├└─\s]/g, '');
        if (!stripped) continue;

        const depth = Math.floor((line.length - line.replace(/^[^a-zA-Z0-9]+/, '').length) / 4);
        stack.length = depth;
        stack[depth] = stripped;
        entries.push(stack.filter(Boolean).join('/'));
      }

      this.passEntries = entries;
    } catch {
      this.passEntries = [];
    }

    return this.passEntries;
  }

  /**
   * Resolves a key reference (pass store, CLI auth, auth.json marker, env
   * var) to its actual secret. Delegates to the pure `resolveKeyRef` so
   * there is exactly one copy of the marker-resolution logic across the
   * whole codebase (see the module-level comment above).
   *
   * Note: unlike the pure version, this returns the unresolved marker
   * verbatim (never null) when resolution fails, preserving the historical
   * `string` return type callers depend on.
   */
  resolveKeyValue(key: string): string {
    return resolveKeyRef(key, this.loadAuth()) ?? key;
  }

  /**
   * Discovers all available keys across all providers
   */
  discoverKeys(): void {
    const auth = this.loadAuth();
    const entries = this.parsePassTree();

    for (const [provId, def] of Object.entries(PROVIDER_MAP)) {
      // Initialize provider configuration
      if (!this.cfg.providers) this.cfg.providers = {};
      if (!this.cfg.providers[provId]) {
        this.cfg.providers[provId] = { billing: def.billing ?? 'pay_per_token' };
      }

      const prov = this.cfg.providers[provId];
      if (!prov.keys) prov.keys = [];

      const existingLabels = new Set(prov.keys.map((k) => k.label ?? k.key));

      // 1. Env var
      if (def.envVar && process.env[def.envVar]) {
        const label = `env:${def.envVar}`;
        if (!existingLabels.has(label)) {
          prov.keys.push({ key: def.envVar, label });
          existingLabels.add(label);
        }
      }

      // 2. auth.json
      if (def.authKey && auth[def.authKey]) {
        const authEntry = auth[def.authKey];
        const label = 'auth.json';
        if (!existingLabels.has(label)) {
          if (authEntry.key) {
            // Reference, not the raw secret -- resolved on demand via
            // resolveKeyValue(). cfg (and thus prov.keys) can be written
            // back to router-config.json (a tracked file, see update_model_metrics
            // in index.ts); storing the plaintext key here would leak it into
            // git history the next time that write path runs.
            prov.keys.push({ key: `__auth_json__:${def.authKey}`, label });
          } else if (authEntry.type === 'oauth' || authEntry.refresh) {
            prov.keys.push({ key: `__oauth__:${def.authKey}`, label: 'auth.json:oauth' });
          }
          existingLabels.add(label);
        }
      }

      // 3. Pass store
      if (def.passPatterns) {
        for (const pattern of def.passPatterns) {
          const matches = entries.filter((e) => e.startsWith(pattern + '/') || e === pattern);
          for (const m of matches) {
            const label = `pass:${m}`;
            if (!existingLabels.has(label)) {
              prov.keys.push({ key: `!pass show ${m}`, label });
              existingLabels.add(label);
            }
          }
        }
      }

      // 4. CLI auth files
      if (def.cliAuthFiles) {
        for (const af of def.cliAuthFiles) {
          const filePath = af.path.replace('~', homedir());
          const label = `cli:${af.path}`;
          if (!existingLabels.has(label)) {
            try {
              if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                if (data[af.tokenField]) {
                  prov.keys.push({ key: `__cli_oauth__:${filePath}:${af.tokenField}`, label });
                  existingLabels.add(label);

                  // Sync CLI OAuth token to pi's auth.json
                  if (def.authKey && data.expiry_date) {
                    try {
                      const auth = this.loadAuth();
                      const existing = auth[def.authKey];
                      if (
                        existing?.type === 'oauth' &&
                        data.expiry_date > (existing.expires ?? 0)
                      ) {
                        existing.access = data[af.tokenField];
                        if (data.refresh_token) existing.refresh = data.refresh_token;
                        existing.expires = data.expiry_date;
                        this.saveAuth(auth);
                      }
                    } catch {
                      /* sync failed, non-fatal */
                    }
                  }
                }
              }
            } catch {
              /* unreadable */
            }
          }
        }
      }

      // 5. Local providers
      if (def.local) {
        if (!existingLabels.has('local')) {
          prov.keys.push({ key: '__local__', label: 'local' });
          existingLabels.add('local');
        }
      }

      // Track providers with at least one key
      if (prov.keys.length > 0) {
        this.discoveredProviders.add(provId);
      }

      // Remove providers with no usable keys
      if (prov.keys.length === 0) {
        delete this.cfg.providers[provId];
      }
    }
  }

  // ── Provider Health ─────────────────────────────────────────────────────

  /**
   * Checks the health status of provider keys
   */
  providerKeyHealth(
    prov: string,
    exhaustedKeys: Record<string, number> = {}
  ): 'valid' | 'exhausted' | 'unchecked' {
    const keys = this.cfg.providers?.[prov]?.keys;
    if (!keys || keys.length === 0) return 'unchecked';

    const idx = 0; // Default to first key
    if (exhaustedKeys[`${prov}:${idx}`] && Date.now() < exhaustedKeys[`${prov}:${idx}`]) {
      // Check if any key is available
      for (let i = 0; i < keys.length; i++) {
        if (!exhaustedKeys[`${prov}:${i}`] || Date.now() >= exhaustedKeys[`${prov}:${i}`]) {
          return 'valid';
        }
      }
      return 'exhausted';
    }
    return 'valid';
  }

  // ── Free Models Discovery ────────────────────────────────────────────

  /**
   * Returns all available free models.
   * Uses free_models from router-config.json (not from PROVIDER_MAP)
   */
  getFreeModels(): string[] {
    const freeModels: string[] = [];

    // Iterate over all providers in the configuration
    for (const [provId, provConfig] of Object.entries(this.cfg.providers ?? {})) {
      // Only include if provider has free_models configured and at least one key
      if (provConfig.free_models && provConfig.free_models.length > 0 && provConfig.keys?.length) {
        freeModels.push(...provConfig.free_models);
      }
    }
    
    return freeModels;
  }

  /**
   * Returns true if any free models are available
   */
  hasFreeModels(): boolean {
    return this.getFreeModels().length > 0;
  }

  // ── Getter ─────────────────────────────────────────────────────────────

  getDiscoveredProviders(): Set<string> {
    return this.discoveredProviders;
  }

  getConfig(): Config {
    return this.cfg;
  }

  getCache(): Cache {
    return this.cache;
  }
}
