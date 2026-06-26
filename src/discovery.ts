// src/discovery.ts
// Provider and model discovery for the pi-model-router

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

import type { Config, Cache, ProviderConfig, ProviderKey } from './types.js';
import { PROVIDER_MAP } from './providers.js';

// ── Constants ────────────────────────────────────────────────────────────

const AUTH_PATH = path.join(homedir(), '.pi', 'agent', 'auth.json');

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
    try {
      return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
    } catch {
      return {};
    }
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
   * Resolves a key value (e.g. pass store reference or CLI auth token)
   */
  resolveKeyValue(key: string): string {
    if (key.startsWith('!pass show ')) {
      try {
        return execSync(key.slice(1) + ' 2>/dev/null', { encoding: 'utf-8' }).trim();
      } catch {
        return key;
      }
    }

    if (key.startsWith('__cli_oauth__:')) {
      const parts = key.slice('__cli_oauth__:'.length);
      const lastColon = parts.lastIndexOf(':');
      const filePath = parts.slice(0, lastColon);
      const field = parts.slice(lastColon + 1);

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data[field]) return data[field];
      } catch {
        /* unreadable */
      }
    }

    return key;
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
            prov.keys.push({ key: authEntry.key, label });
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
   * Returns all available free models
   * Nutzt free_models aus router-config.json (nicht aus PROVIDER_MAP)
   */
  getFreeModels(): string[] {
    const freeModels: string[] = [];
    
    // Durchsuche alle Provider in der Konfiguration
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
