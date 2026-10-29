// Model tables of the `/router` overview. Pure formatting: rows in, lines out.
//
// Lines come back as [header, separator, ...one line per model]. A value the
// router has no measurement or scrape for is printed as "–", never as the
// placeholder the ranking uses internally (gdp 50, 100 tok/s, 1000 ms) — those
// placeholders made unmeasured models look measured.

export interface OverviewRow {
  /** 0-based position in the group's ranking; 0 is the first choice. */
  rank: number;
  ref: string;
  /** null when no GDPval scrape or config value exists for the model. */
  gdpval: number | null;
  /** null until a stream of this model completed in this process. */
  latencyMs: number | null;
  /** null until a stream of this model completed in this process. */
  tps: number | null;
  /** Preformatted price cell, e.g. "$1.4 / $4.4", "free" or "unknown". */
  price: string;
  /** Tokens used over the last 1, 7 and 30 days. */
  usage: [number, number, number];
  /** Remaining budget cell, '' when the provider has no budget. */
  budget: string;
  limited: boolean;
  limitSecs: number;
  /** Cost multiplier after rate-limit hits (1 = none). */
  costMux: number;
  /** Whether this is the model the session is currently using. */
  current: boolean;
  /** Why the model sits here in a `best` group (src/rank-explain.ts); absent elsewhere. */
  why?: string;
}

const DASH = '–';

/** The measurement state of one model's latency/throughput pair. */
export interface MetricsDisplaySource {
  avg_latency_ms: number;
  throughput_tps: number;
  /** Completed streams folded into the latency EMA; 0/undefined = placeholder. */
  samples?: number;
  /** Token-bearing streams folded into the throughput EMA; 0/undefined = placeholder. */
  tps_samples?: number;
}

/** A user's model_metrics entry; only the two displayed keys matter here. */
export interface MetricsUserConfig {
  avg_latency_ms?: number | undefined;
  throughput_tps?: number | undefined;
}

/**
 * The latency/tok-s gate behind the overview columns: a value is shown when
 * it was MEASURED in this process (samples / tps_samples) or explicitly
 * CONFIGURED by the user (model_metrics) — otherwise null (dash). Before this
 * gate existed, a user-configured value was hidden behind a dash until the
 * first stream, and the untouched 100 tok/s placeholder printed as measured
 * once any stream had completed.
 */
export function displayMetricsFor(
  m: MetricsDisplaySource,
  userCfg: MetricsUserConfig | undefined
): { latencyMs: number | null; tps: number | null } {
  return {
    latencyMs: (m.samples ?? 0) > 0 || userCfg?.avg_latency_ms !== undefined ? m.avg_latency_ms : null,
    tps: (m.tps_samples ?? 0) > 0 || userCfg?.throughput_tps !== undefined ? m.throughput_tps : null,
  };
}

/** Token counts with a unit that stays readable: 812, 45k, 1.2M, 303M, 1.9B. */
export function fmtTokens(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

function status(row: OverviewRow): string {
  const parts: string[] = [];
  if (row.rank === 0) parts.push('first');
  if (row.current) parts.push('current');
  if (row.why) parts.push(row.why);
  if (row.limited) parts.push(`⛔ ${row.limitSecs}s`);
  if (row.costMux > 1) parts.push(`cost ×${row.costMux}`);
  if (parts.length === 0) parts.push('ok');
  return parts.join(' · ');
}

/**
 * Header, separator and one line per row. Columns: model, GDPval, latency,
 * tok/s, price per million tokens (in/out), tokens used per window, optional budget,
 * status. Rows are in ranking order (the first one is the first choice). The
 * budget column appears only when some row has a budget. Lines stay under
 * ~110 columns at a 30-column model name; a long status wraps at the end only.
 */
export function formatOverviewTable(rows: OverviewRow[], nameWidth: number): string[] {
  const names = rows.map((r) => (r.ref.length > nameWidth ? '…' + r.ref.slice(-(nameWidth - 1)) : r.ref));
  const showBudget = rows.some((r) => r.budget !== '');
  const width = Math.max(5, Math.min(nameWidth, Math.max(...names.map((n) => n.length), 5)));
  const cols: Array<{ head: string; w: number; left?: boolean }> = [
    { head: 'Model', w: width, left: true },
    { head: 'GDP', w: 4 },
    { head: 'Lat ms', w: 6 },
    { head: 'tok/s', w: 5 },
    { head: '$/M in/out', w: 11 },
    { head: 'use 1d', w: 7 },
    { head: 'use 7d', w: 7 },
    { head: 'use 30d', w: 7 },
    ...(showBudget ? [{ head: 'Budget', w: 7 }] : []),
  ];
  const line = (cells: string[]) =>
    '│ ' + cols.map((c, i) => (c.left ? cells[i].padEnd(c.w) : cells[i].padStart(c.w))).join(' ') + ' ';

  const header = line(cols.map((c) => c.head)) + 'Status';
  const separator = '│ ' + cols.map((c) => '─'.repeat(c.w)).join(' ') + ' ' + '─'.repeat(12);

  const body = rows.map((r, i) => {
    const values = [
      names[i],
      r.gdpval === null ? DASH : String(Math.round(r.gdpval)),
      r.latencyMs === null ? DASH : String(Math.round(r.latencyMs)),
      r.tps === null ? DASH : String(Math.round(r.tps)),
      r.price,
      fmtTokens(r.usage[0]),
      fmtTokens(r.usage[1]),
      fmtTokens(r.usage[2]),
    ];
    if (showBudget) values.push(r.budget || DASH);
    return line(values) + status(r);
  });

  return [header, separator, ...body];
}
