/**
 * Sub-call scope: marks the async call chain of a router-internal sub-call
 * (the bulk_reader delegation of an oversized tool result, the bulk_read
 * tool) so driveStream does not record the sub-call's model as the TURN's
 * model.
 *
 * Why not a flag on the Router: load() replaces the Router instance (every
 * session_start, including subagent sessions that share this module while a
 * parent turn runs, and the dynamic-config swap after a scan), which dropped
 * an in-flight flag; and a process-global flag suppressed legitimate MAIN
 * streams that overlap a sub-call. The scope belongs to the sub-call's own
 * async chain, so neither can happen. Live incident 2026-11-03 and the review
 * of PR #86: see test/subcall-scope-isolation.test.ts.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<true>();

/** Runs `fn` as a sub-call: any router stream it opens is marked as such. */
export function runAsSubCall<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run(true, fn);
}

/** True inside the async chain of runAsSubCall(). */
export function inSubCall(): boolean {
  return scope.getStore() === true;
}
