// Virtual-model shadow report (plan docs/plans/2026-11-04-virtual-models-routing.md,
// spike step 2).
//
//   node scripts/virtual-route-shadow.ts [--log=<router.log>]
//                                        [--decisions=<file>]
//                                        [--since=<iso>] [--until=<iso>]
//                                        [--detail=1]
//
// router.log rotates and the decision log grows, so a result is only
// reproducible with BOTH bounds: quote --since and --until next to any figure.
//
// The plan asks whether the router's own failover could be replaced by Pi's
// virtual models. A virtual model picks ONE physical model per request; when
// that model fails, recovery is Pi's agent-level retry (settings.retry:
// maxRetries 3, baseDelayMs 2000), which calls route() again with
// reason="retry" and the failed model in `failed`. So the question per turn is
// not "did the chain fail over" but "would Pi's retry have recovered it".
//
// This report answers that from the existing logs, without changing routing:
// it classifies the failure the router narrated for the turn's first attempt
// against Pi's own retry rules, then says whether a virtual model would have
// finished the turn the same way, recovered through Pi's retry, or lost it.
//
// Limits, stated in docs/research/2026-11-06-virtual-model-spike.md:
// - The narration is the router's reading of the provider error. Where the raw
//   body is logged (`429 body: …`) it is preferred; otherwise the narration
//   text stands in for what Pi would have seen, which is an approximation.
// - The next candidate is assumed to be the one the chain actually tried. A
//   virtual route() would re-rank from the same pool, so this is close but not
//   identical.
// - A turn is attributed to the group that was decided; attempts of a
//   cross-group cascade count for that group.
// - Every failed attempt of a turn is classified, not only the first: a turn
//   counts as recovered only when all of them are errors Pi would retry and the
//   chain fits Pi's budget. Counts are TURNS, not outages: one provider outage
//   spread over several turns (e.g. a spent five-hour quota) counts once per
//   turn, and a stateful route() would exclude the model after the first
//   failure, so the lost share of such a class is an upper bound.
// - Model refs and counts only; never prompt text.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readDecisionLog } from './lib/decision-log.ts';
import { walkDecisions, type WalkDecision } from './failover-walk.ts';
import { arg, bound, invokedDirectly, pct } from './lib/cli.ts';

/** Pi's retry budget: one request plus three retries. */
export const PI_MAX_ATTEMPTS = 4;

/**
 * Pi's non-retryable wording, mirrored from
 * `pi-ai/dist/utils/retry.js` (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN).
 */
const PI_NON_RETRYABLE =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded|"code"\s*:\s*"?1308(?![0-9])/i;

/**
 * Pi's retryable wording, mirrored from the same file
 * (RETRYABLE_PROVIDER_ERROR_PATTERN). Trimmed to the patterns this report can
 * actually meet in a router narration; the status-code branch is kept as-is.
 */
const PI_RETRYABLE =
  /overloaded|server_busy|servers are currently busy|currently experiencing high demand|model is at capacity|rate.?limit|too many requests|(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])|service.?(?:is.?)?(?:temporarily.?)?unavailable|server.?error|internal.?error|provider.?returned.?(?:an.?)?error|stream was interrupted|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|timed? out|timeout|terminated|ended without|stream ended before|http2 request did not get a response|ResourceExhausted/i;

/** Router annotations appended to a narration; they are not part of the provider text. */
const ROUTER_ANNOTATION = / \((?:likely|resets|backing|until|at )[^()]*\)/g;

/** Failures only the router detects: Pi sees a normal end or nothing at all. */
const PI_BLIND = [
  'empty response',
  'no response within timeout',
  'stuck in a repetition loop',
  'output truncated at max tokens',
  'classify request timed out',
  'summarization error',
];

export type PiVerdict = 'pi-retry' | 'pi-no-retry' | 'pi-blind' | 'router-state';

export interface FailureClass {
  verdict: PiVerdict;
  /** Short label for the report, e.g. `empty response` or `quota or limit wording`. */
  reason: string;
}

/** The narration without its trailing router annotations. */
function bareNarration(narration: string): string {
  const cut = narration.indexOf(' (');
  return (cut === -1 ? narration : narration.slice(0, cut)).trim();
}

/**
 * What Pi would have done with this failure. `body` is the raw 429 body when
 * the router logged one — Pi sees that text, not the router's narration.
 */
export function classifyPiRetry(narration: string, body?: string | null): FailureClass {
  const bare = bareNarration(narration);
  if (PI_BLIND.some((prefix) => bare.startsWith(prefix))) {
    return { verdict: 'pi-blind', reason: bare };
  }
  if (/^all \d+ candidate\(s\) in cooldown/.test(bare)) {
    return { verdict: 'router-state', reason: bare };
  }
  // Pi sees the status code in front of the body (`429: {…}`), and its pattern
  // matches that code. The router only logs a body for 429s, so it is restored.
  const text = (body ? `429: ${body}` : narration).replace(ROUTER_ANNOTATION, '');
  if (PI_NON_RETRYABLE.test(text)) {
    return { verdict: 'pi-no-retry', reason: 'quota or limit wording' };
  }
  if (PI_RETRYABLE.test(text)) return { verdict: 'pi-retry', reason: 'retryable provider error' };
  return { verdict: 'pi-no-retry', reason: 'unrecognised error' };
}

export interface ShadowRow {
  ts: number;
  proc: string;
  group: string;
  firstAttempt: string | null;
  success: string | null;
  /** Attempts the chain needed; `PI_MAX_ATTEMPTS + 1` when it never succeeded. */
  attempts: number;
  /** How Pi would have handled the first failure; null when the first attempt served. */
  verdict: PiVerdict | null;
  reason: string | null;
  virtualOutcome: 'same' | 'recovered' | 'lost';
  /** Why the turn would be lost, e.g. `pi-blind: empty response`. */
  lostBecause: string | null;
}

type FailEvent = { ts: number; proc: string; ref: string; narration: string };
type BodyEvent = { ts: number; proc: string; ref: string; body: string };

const LINE = /^(\S+)\s+\[([^\]]+)\]\s+(.*)$/;
const FAILED = /^\[router\] (\S+) — (.*)$/;
const BODY = /^\[router\] (\S+) 429 body: (.*)$/;

/** Failure narrations and logged 429 bodies, keyed by the model they belong to. */
export function parseFailures(lines: string[]): { fails: FailEvent[]; bodies: BodyEvent[] } {
  const fails: FailEvent[] = [];
  const bodies: BodyEvent[] = [];
  for (const line of lines) {
    const m = line.match(LINE);
    if (!m) continue;
    const [, iso, proc, msg] = m;
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) continue;
    const body = msg.match(BODY);
    if (body) {
      bodies.push({ ts, proc, ref: body[1], body: body[2] });
      continue;
    }
    const fail = msg.match(FAILED);
    if (!fail) continue;
    // The narration ends with ", trying <next> …" on failover lines.
    const narration = fail[2].replace(/, trying \S+ …$/, '').trim();
    fails.push({ ts, proc, ref: fail[1], narration });
  }
  return { fails, bodies };
}

/** One row per routed turn: what a virtual model would have done with it. */
export function shadowTurns(lines: string[], decisions: WalkDecision[]): ShadowRow[] {
  const { fails, bodies } = parseFailures(lines);
  return walkDecisions(lines, decisions).map((row) => {
    const base = {
      ts: row.ts,
      proc: row.proc,
      group: row.group,
      firstAttempt: row.firstAttempt,
      success: row.success,
      attempts: row.success === null ? PI_MAX_ATTEMPTS + 1 : row.attempts.length,
    };
    if (row.firstAttempt === null || row.success === row.firstAttempt) {
      return { ...base, verdict: null, reason: null, virtualOutcome: 'same', lostBecause: null };
    }
    // The turn's own window: no failure of a later turn can bind to it.
    const inTurn = <E extends { proc: string; ts: number }>(e: E): boolean =>
      e.proc === row.proc && e.ts >= row.ts && e.ts <= row.end;
    const turnFails = fails.filter(inTurn);
    const fail = turnFails.find((f) => f.ref === row.firstAttempt);
    if (!fail) {
      return {
        ...base,
        verdict: null,
        reason: null,
        virtualOutcome: 'lost',
        lostBecause: 'no failure narrated for the first attempt',
      };
    }
    const classify = (f: FailEvent): { verdict: PiVerdict; reason: string } =>
      classifyPiRetry(f.narration, bodies.find((b) => inTurn(b) && b.ref === f.ref)?.body);
    const { verdict, reason } = classify(fail);
    if (row.success === null) {
      return {
        ...base,
        verdict,
        reason,
        virtualOutcome: 'lost',
        lostBecause: `${verdict}: ${reason}`,
      };
    }
    // Any later failure Pi would not retry ends the chain there, whatever the
    // first one was: the router's cascade carried on, Pi's retry would not.
    for (const later of turnFails) {
      if (later === fail) continue;
      const c = classify(later);
      if (c.verdict !== 'pi-retry') {
        return {
          ...base,
          verdict,
          reason,
          virtualOutcome: 'lost',
          lostBecause: `later failure, ${c.verdict}: ${c.reason}`,
        };
      }
    }
    if (verdict === 'pi-retry' && base.attempts <= PI_MAX_ATTEMPTS) {
      return { ...base, verdict, reason, virtualOutcome: 'recovered', lostBecause: null };
    }
    if (verdict === 'pi-retry') {
      return {
        ...base,
        verdict,
        reason,
        virtualOutcome: 'lost',
        lostBecause: `retry budget: needed ${base.attempts} attempts, Pi allows ${PI_MAX_ATTEMPTS}`,
      };
    }
    return {
      ...base,
      verdict,
      reason,
      virtualOutcome: 'lost',
      lostBecause: `${verdict}: ${reason}`,
    };
  });
}

export interface ShadowGroupSummary {
  turns: number;
  same: number;
  recovered: number;
  lost: number;
  lostBy: Record<string, number>;
}

/** Per-group counters: unchanged, recovered by Pi's retry, or lost. */
export function summarizeShadow(rows: ShadowRow[]): Record<string, ShadowGroupSummary> {
  const out: Record<string, ShadowGroupSummary> = {};
  for (const row of rows) {
    const g = (out[row.group] ??= { turns: 0, same: 0, recovered: 0, lost: 0, lostBy: {} });
    g.turns++;
    g[row.virtualOutcome]++;
    if (row.lostBecause) g.lostBy[row.lostBecause] = (g.lostBy[row.lostBecause] ?? 0) + 1;
  }
  return out;
}

function main(): void {
  const logPath = arg('log') ?? join(homedir(), '.pi/logs/router.log');
  const decPath = arg('decisions') ?? join(homedir(), '.pi/logs/classifier-decisions.jsonl');
  const since = bound('since', process.argv.slice(2), -Infinity);
  const until = bound('until', process.argv.slice(2), Infinity);
  if (!existsSync(logPath)) {
    console.error(`no router log at ${logPath}`);
    process.exit(2);
  }
  const lines = readFileSync(logPath, 'utf8').split('\n');
  const decisions: WalkDecision[] = readDecisionLog(decPath, { since, until })
    .filter((row) => row.proc !== null)
    .map((row) => ({ ts: row.ts, proc: row.proc!, group: row.group, stage: row.stage }));
  const rows = shadowTurns(lines, decisions);
  const total = { turns: 0, same: 0, recovered: 0, lost: 0 };
  console.log(`bounds: since=${arg('since') ?? '-'} until=${arg('until') ?? '-'}`);
  for (const [group, s] of Object.entries(summarizeShadow(rows))) {
    console.log(
      `  ${group.padEnd(14)} turns=${s.turns} same=${s.same} recovered=${s.recovered} lost=${s.lost}`
    );
    for (const [why, n] of Object.entries(s.lostBy).sort((a, b) => b[1] - a[1])) {
      console.log(`      lost ${String(n).padStart(3)}× ${why}`);
    }
    total.turns += s.turns;
    total.same += s.same;
    total.recovered += s.recovered;
    total.lost += s.lost;
  }
  console.log(
    `total turns=${total.turns} same=${total.same} (${pct(total.same, total.turns)}) recovered=${total.recovered} (${pct(total.recovered, total.turns)}) lost=${total.lost} (${pct(total.lost, total.turns)})`
  );
  if (process.argv.includes('--detail') || arg('detail') !== undefined) {
    console.log('lost turns:');
    for (const row of rows.filter((r) => r.virtualOutcome === 'lost')) {
      console.log(
        `  ${new Date(row.ts).toISOString()} ${row.group} ${row.firstAttempt} -> ${row.success ?? 'none'} | ${row.lostBecause}`
      );
    }
  }
}

if (invokedDirectly(import.meta.url)) main();
