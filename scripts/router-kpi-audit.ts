// scripts/router-kpi-audit.ts
// KPI audit over ~/.pi/logs/router.log: delegation savings (ADR-0007),
// failover health (ADR-0013), learned blocklist (ADR-0008) and the
// local-provider watchdog (ADR-0016).
//
// Usage: node scripts/router-kpi-audit.ts [--log <path>] [--since <7d|24h|ISO>] [--json]
// Reads the log and its rotations (<log>.N … <log>.1, oldest first), line by line.

import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Kpis {
  lines: number;
  firstTs?: string;
  lastTs?: string;
  delegation: {
    replaced: number;
    byTool: Record<string, number>;
    charsIn: number;
    charsOut: number;
    inflated: number;
    failed: number;
    noUsableSummary: number;
  };
  readBlocks: { expensive: number; size: number };
  hops: { failures: number; byReason: Record<string, number>; byModel: Record<string, number> };
  allCandidatesFailed: number;
  blocklist: { blocked: number; byReason: Record<string, number>; cleared: number };
  watchdog: { wedged: number; classifierSkips: number };
  classifier: { byCategory: Record<string, number>; noSchema501: number; fallbackFailed: number };
}

export function createKpis(): Kpis {
  return {
    lines: 0,
    delegation: { replaced: 0, byTool: {}, charsIn: 0, charsOut: 0, inflated: 0, failed: 0, noUsableSummary: 0 },
    readBlocks: { expensive: 0, size: 0 },
    hops: { failures: 0, byReason: {}, byModel: {} },
    allCandidatesFailed: 0,
    blocklist: { blocked: 0, byReason: {}, cleared: 0 },
    watchdog: { wedged: 0, classifierSkips: 0 },
    classifier: { byCategory: {}, noSchema501: 0, fallbackFailed: 0 },
  };
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

const TS = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s{2}(.*)$/;

function hopReason(text: string): string {
  if (/no response within timeout/.test(text)) return 'timeout';
  if (/stream stalled/.test(text)) return 'stall';
  if (/rate limit|spend limit/.test(text)) return 'rate_limit';
  if (/provider error/.test(text)) return 'provider_error';
  if (/repetition loop/.test(text)) return 'repetition';
  if (/context window|too large/.test(text)) return 'context_overflow';
  if (/empty response/.test(text)) return 'empty';
  if (/^error:/.test(text)) return 'thrown';
  return 'other';
}

/** Feeds one log line. Lines before `sinceMs` and lines without a timestamp are ignored. */
export function ingestLine(k: Kpis, line: string, sinceMs?: number): void {
  const m = TS.exec(line);
  if (!m) return;
  const [, ts, body] = m as unknown as [string, string, string];
  if (sinceMs !== undefined && Date.parse(ts) < sinceMs) return;
  k.lines++;
  k.firstTs ??= ts;
  k.lastTs = ts;

  let r: RegExpExecArray | null;
  if ((r = /^\[delegation\] replaced (\d+)-char (\w+) result with (\d+)-char summary/.exec(body))) {
    const before = Number(r[1]);
    const after = Number(r[3]);
    k.delegation.replaced++;
    bump(k.delegation.byTool, r[2]!);
    k.delegation.charsIn += before;
    k.delegation.charsOut += after;
    if (after >= before) k.delegation.inflated++;
    return;
  }
  if (body.startsWith('[delegation] failed')) { k.delegation.failed++; return; }
  if (body.startsWith('[delegation] sub-call produced no usable summary')) { k.delegation.noUsableSummary++; return; }
  if (body.startsWith('[bulk_read] blocked a full-file read')) {
    if (body.includes('by expensive model')) k.readBlocks.expensive++;
    else k.readBlocks.size++;
    return;
  }
  if ((r = /^\[router\] All \d+ candidate\(s\) failed/.exec(body))) { k.allCandidatesFailed++; return; }
  if ((r = /^\[router\] \S+ blocked for \d+ days?: ([\w-]+)/.exec(body))) {
    k.blocklist.blocked++;
    bump(k.blocklist.byReason, r[1]!);
    return;
  }
  if (/^\[router\] \S+ answered after its blocklist entry expired/.test(body)) { k.blocklist.cleared++; return; }
  if (/^\[router\] watchdog: \S+ looks wedged/.test(body)) { k.watchdog.wedged++; return; }
  if (body.startsWith('[classifier] Ollama marked wedged')) { k.watchdog.classifierSkips++; return; }
  if (body.includes('rejects structured output (501)')) { k.classifier.noSchema501++; return; }
  if (body.startsWith('[classifier] Fallback model also failed')) { k.classifier.fallbackFailed++; return; }
  if ((r = /^\[router\] (\S+) — (.+?)(?:, trying \S+ …)?$/.exec(body))) {
    const reason = hopReason(r[2]!);
    k.hops.failures++;
    bump(k.hops.byReason, reason);
    bump(k.hops.byModel, r[1]!);
    return;
  }
  if ((r = /^([a-z_]+) → [a-z_]+\s{2}\S/.exec(body))) {
    bump(k.classifier.byCategory, r[1]!);
  }
}

const top = (m: Record<string, number>, n: number) =>
  Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n);

export function formatReport(k: Kpis): string {
  const d = k.delegation;
  const saved = d.charsIn - d.charsOut;
  const pct = d.charsIn ? Math.round((saved / d.charsIn) * 100) : 0;
  const out: string[] = [
    `Router KPI audit — ${k.lines} log lines${k.firstTs ? ` (${k.firstTs} … ${k.lastTs})` : ''}`,
    '',
    'Delegation (ADR-0007)',
    `  replaced results: ${d.replaced} (${top(d.byTool, 5).map(([t, n]) => `${t} ${n}`).join(', ') || '—'})`,
    `  chars in → out:   ${d.charsIn} → ${d.charsOut} (saved ${saved}, ${pct}%)`,
    `  inflated (summary ≥ original): ${d.inflated}`,
    `  failed / no usable summary:    ${d.failed} / ${d.noUsableSummary}`,
    `  full-file reads blocked:       ${k.readBlocks.expensive} expensive-model, ${k.readBlocks.size} size`,
    '',
    'Failover (ADR-0013)',
    `  failed hops: ${k.hops.failures} (${top(k.hops.byReason, 8).map(([r, n]) => `${r} ${n}`).join(', ') || '—'})`,
    `  all candidates failed: ${k.allCandidatesFailed}`,
    '  most failing models:',
    ...top(k.hops.byModel, 10).map(([m, n]) => `    ${String(n).padStart(6)}  ${m}`),
    '',
    'Learned blocklist (ADR-0008)',
    `  blocks: ${k.blocklist.blocked} (${top(k.blocklist.byReason, 8).map(([r, n]) => `${r} ${n}`).join(', ') || '—'}), cleared after re-probe: ${k.blocklist.cleared}`,
    '',
    'Local-provider watchdog (ADR-0016)',
    `  wedge events: ${k.watchdog.wedged}, classifier skips while wedged: ${k.watchdog.classifierSkips}`,
    '',
    'Classifier',
    `  categories: ${top(k.classifier.byCategory, 10).map(([c, n]) => `${c} ${n}`).join(', ') || '—'}`,
    `  primary 501 (no structured output): ${k.classifier.noSchema501}, fallback failed: ${k.classifier.fallbackFailed}`,
  ];
  return out.join('\n');
}

/** The log and its rotated predecessors, oldest first (see src/logger.ts). */
export function logFiles(base: string, maxRotations = 20): string[] {
  const rotated: string[] = [];
  for (let i = maxRotations; i >= 1; i--) if (existsSync(`${base}.${i}`)) rotated.push(`${base}.${i}`);
  return existsSync(base) ? [...rotated, base] : rotated;
}

/** Parses `7d`, `24h`, `30m` or an ISO date into epoch ms. */
export function parseSince(value: string, now: number = Date.now()): number {
  const rel = /^(\d+)([dhm])$/.exec(value);
  if (rel) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[rel[2] as 'd' | 'h' | 'm'];
    return now - Number(rel[1]) * unit;
  }
  const abs = Date.parse(value);
  if (Number.isNaN(abs)) throw new Error(`--since: cannot parse "${value}" (use 7d, 24h, 30m or an ISO date)`);
  return abs;
}

async function main(argv: string[]): Promise<void> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const logPath = arg('--log') ?? join(homedir(), '.pi', 'logs', 'router.log');
  const sinceArg = arg('--since');
  const sinceMs = sinceArg ? parseSince(sinceArg) : undefined;
  const k = createKpis();
  for (const file of logFiles(logPath)) {
    const rl = createInterface({ input: createReadStream(file, 'utf-8'), crlfDelay: Infinity });
    for await (const line of rl) ingestLine(k, line, sinceMs);
  }
  console.log(argv.includes('--json') ? JSON.stringify(k, null, 2) : formatReport(k));
}

// import.meta.url is the real path, URL-encoded: a plain `file://${argv[1]}`
// misses paths with spaces or symlinks, and the script then exits silently.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
