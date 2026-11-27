// Exit decision of router-shape-run.ts (host-upgrade gate, AGENTS §10).
// Covered by test/spike-gate-lib.test.ts.
//
// The gate compares a run against the recorded baseline of the current Pi
// version: a check that fails without being recorded as failing blocks the
// upgrade, and so does a recorded failure that no longer fails — the host
// changed, so the baseline (and the spike note) gets re-recorded by hand.

export interface CheckResult {
  id: string;
  /** true = PASS, false = FAIL, null = INFO (no pass criterion). */
  ok: boolean | null;
}

export interface ShapeVerdict {
  exitCode: 0 | 1;
  unexpectedFail: string[];
  unexpectedPass: string[];
}

/**
 * Checks that fail on Pi 1.6.0 by design of the host, not of the router:
 * G1b — re-registering the group provider at session_start puts the group
 * models back into the availability snapshot until the queued refresh lands
 * (docs/research/2026-11-21-router-shape-spike.md §2).
 */
export const PI_1_6_0_EXPECTED_FAIL: ReadonlySet<string> = new Set(['G1b']);

export function shapeVerdict(
  results: readonly CheckResult[],
  expectedFail: ReadonlySet<string> = PI_1_6_0_EXPECTED_FAIL
): ShapeVerdict {
  const failed = new Set(results.filter((r) => r.ok === false).map((r) => r.id));
  const unexpectedFail = [...failed].filter((id) => !expectedFail.has(id));
  const unexpectedPass = [...expectedFail].filter((id) => !failed.has(id));
  const exitCode = unexpectedFail.length > 0 || unexpectedPass.length > 0 ? 1 : 0;
  return { exitCode, unexpectedFail, unexpectedPass };
}
