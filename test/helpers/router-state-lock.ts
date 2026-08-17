// Several test files back up and restore the same physical,
// repo-root-relative router-config.dynamic.json and .cache/scan-cache.json.
// Both paths are resolved from index.ts's own directory (extDir), not from
// any per-test cwd mock, so they're global state shared by every vitest
// worker process running these files concurrently. Without serializing
// access, two workers racing to rename/restore the same path can throw
// ENOENT (source already moved by the other worker) or hand each other a
// transiently wrong/missing file mid-test — producing "No available models
// for group ..." or similar spurious failures that have nothing to do with
// the code under test.
//
// This is a cross-process mutex built on the one truly atomic filesystem
// primitive Node exposes portably: mkdir fails with EEXIST if the directory
// already exists, and that check-and-create is atomic at the OS level.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_DIR = path.join(os.tmpdir(), 'pi-router-test-shared-state.lock');

/** Blocks until the shared-state lock is held by this test. */
export async function acquireRouterStateLock(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for router test state lock at ${LOCK_DIR}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Releases the shared-state lock. Safe to call even if not currently held. */
export function releaseRouterStateLock(): void {
  try {
    fs.rmdirSync(LOCK_DIR);
  } catch {
    /* already released, or never acquired */
  }
}

/**
 * Runs `fn` with exclusive access to the shared router-config.dynamic.json /
 * .cache/scan-cache.json files. Any test that moves those paths aside and
 * restores them must wrap the whole move-aside/run/restore span in this (or
 * the acquire/release pair above for beforeEach/afterEach-style setups), so
 * concurrent test files can't race on the same physical file.
 */
export async function withSharedRouterStateLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireRouterStateLock();
  try {
    return await fn();
  } finally {
    releaseRouterStateLock();
  }
}
