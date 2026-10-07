// scripts/provider-breaker-replay.ts
// Offline replay of a router.log through the provider circuit breaker
// (docs/plans/2026-10-06-provider-circuit-breaker.md, Phase 4): no live
// provider is contacted. The replay answers the plan's validation gate —
// "no trip on the mistral 400/422 days, trips on every bridge cascade" —
// and reports avoided hops and false trips over the whole log, the tuning
// evidence for the breaker's thresholds.
//
// Usage: node scripts/provider-breaker-replay.ts [--log <path>] [--json]
//
// Event extraction (bounded, no full-fidelity re-simulation):
// - Failure narration lines "[router] <ref> — <text>" map to the D1 evidence
//   kinds. The empty-response label changed wording over the log's time
//   range ("likely rate limit" / "likely subscription spend limit" were
//   disproven guesses, see emptyResponseLabel in stream-orchestrator.ts) —
//   all three variants are the same observable failure and map to
//   empty_response. Rate-limit lines are NOT evidence.
// - "[stream] <ref> finished (stopReason: <r>, <n> chars)" with n > 0 is a
//   success: any success closes the breaker (plan D5), so it must be fed to
//   the replay.
// - Avoided hops are counted as the failure events of a provider that fall
//   inside one of its own open windows (the hops a pre-flight skip would
//   have saved, upper bound: a forced half-open probe still burns one).

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  recordProviderFailure,
  recordProviderSuccess,
  countsAsProviderEvidence,
  BREAKER_COOLDOWN_LADDER_MS,
  WEDGE_WINDOW_MS,
} from '../src/provider-breaker.ts';
import type { Cache } from '../src/types.ts';

type EvidenceKind = 'empty_response' | 'empty_timeout' | 'stall_timeout' | 'provider_error';

interface FailureEvent {
  ts: number;
  ref: string;
  kind: EvidenceKind;
  detail?: string;
  line: string;
}

interface TripEvent {
  provider: string;
  at: number;
  evidence: { ref: string; kind: EvidenceKind; detail?: string }[];
}

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})Z/;
const FAIL_RE = /\[router\] ([a-z0-9][a-z0-9-]*\/[^\s]+) — (.*)$/;
const FINISH_RE = /\[stream\] ([a-z0-9][a-z0-9-]*\/[^\s]+) finished \(stopReason: ([a-z]+), (\d+) chars\)/;

/** Maps a failure narration to its D1 evidence kind, or null when it is not evidence. */
function classifyFailureLine(text: string): { kind: EvidenceKind; detail?: string } | null {
  if (text.startsWith('empty response (no content') || text.startsWith('empty response (likely')) {
    return { kind: 'empty_response' };
  }
  if (text.startsWith('no response within timeout')) {
    return { kind: 'empty_timeout' };
  }
  if (text.startsWith('stream stalled')) {
    return { kind: 'stall_timeout' };
  }
  if (text.startsWith('provider error: ')) {
    // The narration appends annotations after the detail: "(likely rate
    // limit)", "(backing off …", "(resets …" and ", trying <ref> …".
    let detail = text.slice('provider error: '.length);
    const cut = detail.search(/ \((likely rate limit|backing off|resets )|, trying /);
    if (cut > 0) detail = detail.slice(0, cut);
    return { kind: 'provider_error', detail };
  }
  if (text.startsWith('error: ')) {
    return { kind: 'provider_error', detail: text.slice('error: '.length) };
  }
  // rate limit/spend limit reached, free-tier daily cap, context window …
  return null;
}

function parseLine(line: string): { kind: 'failure'; ev: FailureEvent } | { kind: 'success'; ref: string; ts: number } | null {
  const tsMatch = line.match(TS_RE);
  if (!tsMatch) return null;
  const ts = Date.parse(`${tsMatch[1]}Z`);
  const fail = line.match(FAIL_RE);
  if (fail) {
    const cls = classifyFailureLine(fail[2]);
    if (!cls) return null;
    return {
      kind: 'failure',
      ev: { ts, ref: fail[1], ...cls, line: line.trim() },
    };
  }
  const fin = line.match(FINISH_RE);
  if (fin && Number(fin[3]) > 0) {
    return { kind: 'success', ref: fin[1], ts };
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const logArg = args.indexOf('--log');
  const logPath = logArg >= 0 ? args[logArg + 1] : join(homedir(), '.pi', 'logs', 'router.log');
  const asJson = args.includes('--json');
  // --extract <fromISO> <toISO>: bounded, sanitized fixture for the replay
  // TEST (test/provider-breaker-replay.test.ts) — only the parsed events of
  // the window, no paths, no host names, no session tags. Phase 4 of the
  // breaker plan builds its fixtures this way.
  const extractArg = args.indexOf('--extract');
  if (extractArg >= 0) {
    const from = Date.parse(args[extractArg + 1]);
    const to = Date.parse(args[extractArg + 2]);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      console.error('--extract needs <fromISO> <toISO>');
      process.exit(2);
    }
    const events: unknown[] = [];
    const rlExtract = createInterface({ input: createReadStream(logPath), crlfDelay: Infinity });
    for await (const raw of rlExtract) {
      const parsed = parseLine(raw);
      if (!parsed) continue;
      if (parsed.kind === 'success') {
        if (parsed.ts >= from && parsed.ts <= to) {
          events.push({ ts: parsed.ts, ref: parsed.ref, ok: true });
        }
        continue;
      }
      if (parsed.ev.ts >= from && parsed.ev.ts <= to) {
        events.push({
          ts: parsed.ev.ts,
          ref: parsed.ev.ref,
          kind: parsed.ev.kind,
          ...(parsed.ev.detail !== undefined ? { detail: parsed.ev.detail } : {}),
        });
      }
    }
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  const cache: Cache = {};
  const trips: TripEvent[] = [];
  const failuresByProvider = new Map<string, { count: number; counted: number; kinds: Record<string, number> }>();
  let failureLines = 0;
  let countedEvidence = 0;
  let successes = 0;
  const openWindows: { provider: string; until: number }[] = [];
  const avoidedHops = new Map<string, number>();
  const falseTrips: TripEvent[] = [];

  const rl = createInterface({ input: createReadStream(logPath), crlfDelay: Infinity });
  for await (const raw of rl) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.kind === 'success') {
      successes++;
      recordProviderSuccess(cache, parsed.ref);
      continue;
    }
    const ev = parsed.ev;
    failureLines++;
    const provider = ev.ref.split('/')[0];
    const bucket = failuresByProvider.get(provider) ?? { count: 0, counted: 0, kinds: {} };
    bucket.count++;
    bucket.kinds[ev.kind] = (bucket.kinds[ev.kind] ?? 0) + 1;
    failuresByProvider.set(provider, bucket);

    // Avoided-hop estimate: a failure inside one of the provider's own open
    // windows is a hop the pre-flight skip would have saved.
    if (openWindows.some((w) => w.provider === provider && ev.ts < w.until)) {
      avoidedHops.set(provider, (avoidedHops.get(provider) ?? 0) + 1);
    }

    if (!countsAsProviderEvidence(ev.kind, ev.detail)) continue;
    countedEvidence++;
    bucket.counted++;

    const before = cache.provider_breaker?.[provider];
    const newlyOpen = recordProviderFailure(cache, ev.ref, ev.kind, ev.detail, ev.ts);
    if (newlyOpen) {
      const evidence = Object.entries(before?.evidence ?? {}).map(([ref, e]) => ({
        ref,
        kind: (e as { kind: EvidenceKind }).kind,
      }));
      const trip: TripEvent = { provider, at: ev.ts, evidence };
      trips.push(trip);
      // A trip counts as false when NOTHING in its evidence is a D1-class
      // failure (all non-evidence texts slipped through) — with the filter
      // active this should never fire; it is the replay's own sanity net.
      if (evidence.length === 0) falseTrips.push(trip);
      openWindows.push({ provider, until: ev.ts + BREAKER_COOLDOWN_LADDER_MS[0] });
    }
  }

  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const tripsByProviderDay = new Map<string, number>();
  for (const t of trips) {
    const key = `${t.provider} ${day(t.at)}`;
    tripsByProviderDay.set(key, (tripsByProviderDay.get(key) ?? 0) + 1);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          logPath,
          failureLines,
          countedEvidence,
          successes,
          trips: trips.map((t) => ({ provider: t.provider, at: new Date(t.at).toISOString(), evidence: t.evidence })),
          tripsByProviderDay: [...tripsByProviderDay.entries()],
          avoidedHops: [...avoidedHops.entries()],
          falseTrips: falseTrips.length,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`provider-breaker replay — ${logPath}`);
  console.log(`  failure lines parsed: ${failureLines} (D1 evidence: ${countedEvidence}), successes: ${successes}`);
  console.log('');
  console.log('Failure lines per provider (all parsed / D1-counted):');
  for (const [provider, b] of [...failuresByProvider.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(
      `  ${provider}: ${b.count} parsed, ${b.counted} counted — kinds: ${Object.entries(b.kinds)
        .map(([k, n]) => `${k}=${n}`)
        .join(' ')}`
    );
  }
  console.log('');
  console.log(`Trips (${trips.length}), window ${WEDGE_WINDOW_MS / 60_000} min:`);
  for (const t of trips) {
    const evs = t.evidence.map((e) => `${e.ref.split('/')[1]}(${e.kind})`).join(', ');
    console.log(`  ${day(t.at)} ${new Date(t.at).toISOString().slice(11, 19)}  ${t.provider}  [${evs}]`);
  }
  console.log('');
  console.log('Avoided hops (failures inside own open windows, upper bound):');
  for (const [provider, hops] of [...avoidedHops.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${provider}: ${hops}`);
  }
  const totalHops = [...avoidedHops.values()].reduce((a, b) => a + b, 0);
  console.log(`  total: ${totalHops}`);
  console.log('');
  console.log(`False trips (evidence empty at trip time): ${falseTrips.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
