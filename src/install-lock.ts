// One install at a time per target directory.
//
// Both installers (the Laya model set and the ONNX runtime) stage into
// `<dir>.tmp`, move the previous install to `<dir>.old` and rename the staging
// dir into place. Two runs that pick the same target therefore move and delete
// each other's files, and the survivor is missing files without any error. The
// lock is a file created with O_EXCL: cheap, cross-process, and gone when the
// run ends.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { messageOf } from './format.ts';

/** Held while an install runs. */
export const LOCK_SUFFIX = '.install-lock';
/** A lock untouched this long was left behind by a crash, not by a running install. */
export const LOCK_STALE_MS = 10 * 60_000;

export type LockResult =
  | { ok: true; lockFile: string; release: () => void }
  | { ok: false; lockFile: string; reason: 'busy' | 'io'; message: string };

/**
 * Takes the lock for `target` (the final directory, not the staging dir), or
 * explains who holds it. Callers turn `reason` into their own error type.
 */
export function acquireInstallLock(target: string, now = Date.now()): LockResult {
  const lockFile = `${target}${LOCK_SUFFIX}`;
  const busy = (): LockResult => ({
    ok: false,
    lockFile,
    reason: 'busy',
    message:
      `another install of this directory is running (lock: ${lockFile}); a lock ` +
      `untouched for ${String(Math.round(LOCK_STALE_MS / 60_000))} minutes counts as stale`,
  });

  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      lockFile,
      reason: 'io',
      message: `cannot create ${path.dirname(lockFile)}: ${messageOf(err)}`,
    };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, `${String(process.pid)} ${new Date(now).toISOString()}\n`, {
        flag: 'wx',
      });
      return { ok: true, lockFile, release: () => fs.rmSync(lockFile, { force: true }) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return {
          ok: false,
          lockFile,
          reason: 'io',
          message: `cannot take ${lockFile}: ${messageOf(err)}`,
        };
      }
      let age: number;
      try {
        age = now - fs.statSync(lockFile).mtimeMs;
      } catch {
        continue; // released between the write and the stat: try once more
      }
      if (age < LOCK_STALE_MS) return busy();
      // Stale: whoever held it is gone. Take it over.
      fs.rmSync(lockFile, { force: true });
    }
  }
  return busy();
}
