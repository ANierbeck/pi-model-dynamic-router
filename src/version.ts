import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/**
 * Read the router's own version from its package.json. Best-effort: returns
 * 'unknown' if the file is missing or unreadable — this must never block
 * boot. The result is cached after the first read.
 *
 * Used by load() to log the active version once per process, so the router
 * log identifies WHICH installation is active (important when several
 * installs coexist on the same machine).
 */
export function readRouterVersion(): string {
  if (cached !== null) return cached;
  try {
    // package.json sits one level up from src/ (at the extension root).
    const pkg = JSON.parse(
      fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
    );
    cached = (pkg.version as string) ?? 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
