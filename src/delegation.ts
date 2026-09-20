/**
 * Enforced delegation (ADR-0007, revised 2026-09-20): shrink oversized
 * file-inspection tool results with a cheap summarizer model BEFORE the
 * main model sees them — Spotify's "bulk-reader" pattern, built into the
 * router.
 *
 * Coverage (default: `read` AND `bash`, configurable via delegation.tools):
 * log evidence from 2026-09-20 showed zero real-session fires — every file
 * inspection in the observed sessions ran through bash (sed/grep/cat),
 * which a read-only hook never saw. Bash output reaches the same 50 KB
 * truncation ceiling as read output, so both dominant inspection tools
 * are covered out of the box.
 *
 * Design: docs/plans/2026-09-20-enforced-delegation-spike-and-design.md
 *
 * Everything here is strictly fail-open: on ANY miss, error, or suspicious
 * sub-call output, the handler returns undefined and the original tool
 * result passes through untouched. The main model must never lose content
 * because delegation broke.
 *
 * All model access goes through Pi's public registry API (ctx.modelRegistry)
 * — the delegation group (default `bulk_reader`) is a router group provider,
 * so the summarization call is itself routed by the router. Zero coupling
 * to router internals; zero provider registration (no Ü1 risk).
 */

import type { Config, DelegationConfig } from './types.ts';
import type { Usage } from '@earendil-works/pi-ai';

// ── Settings ─────────────────────────────────────────────────────────────

export interface DelegationSettings {
  enabled: boolean;
  /** Minimum joined text length of a tool result to be delegated. */
  min_chars: number;
  /** Router group whose models perform the summarization. */
  group: string;
  /** Cap of raw text passed to the summarizer (protects the sub-call prompt). */
  max_raw_chars: number;
  /** Tool names whose oversized results get delegated. */
  tools: string[];
}

const DEFAULTS: DelegationSettings = {
  enabled: false,
  // Portal/shunt-aligned (Spotify engineering, 2026-09): shunt blocks full
  // reads > 350 lines (~3500 chars at ~10 chars/line). Below this the 10-30s
  // delegation latency exceeds the savings; above it the expensive model was
  // burning tokens on bulk I/O it barely reasoned about. The old 20000-char
  // default let the dominant real-world case (100-500-line reads) pass the
  // expensive model untouched — the exact waste the shunt pattern targets.
  min_chars: 3500,
  group: 'bulk_reader',
  max_raw_chars: 60000,
  tools: ['read', 'bash'],
};

/**
 * Effective delegation settings for the given config. Missing config or
 * missing `delegation` block → disabled (fail-open by default; the fork's
 * router-config.json opts in).
 *
 * `tools` is trusted only as a whole: a non-array value or any non-string /
 * empty-string entry discards the entire list and falls back to the default
 * — a partially-trusted list would silently delegate the wrong tools.
 */
export function delegationSettings(cfg: Config | undefined): DelegationSettings {
  const d = cfg?.delegation ?? {};
  const toolsRaw = (d as DelegationConfig).tools;
  const tools =
    Array.isArray(toolsRaw) && toolsRaw.every((t) => typeof t === 'string' && t.trim().length > 0)
      ? toolsRaw.map((t) => t.trim())
      : DEFAULTS.tools;
  return {
    enabled: d.enabled === true,
    min_chars: typeof d.min_chars === 'number' && d.min_chars > 0 ? d.min_chars : DEFAULTS.min_chars,
    group: typeof d.group === 'string' && d.group ? d.group : DEFAULTS.group,
    max_raw_chars:
      typeof d.max_raw_chars === 'number' && d.max_raw_chars > 0 ? d.max_raw_chars : DEFAULTS.max_raw_chars,
    tools,
  };
}

// ── Content shape safety ─────────────────────────────────────────────────

/**
 * Joins an all-text content block array into a single string.
 * Returns null when content is missing/empty or contains ANY non-text
 * block (images, attachments …) — partial summarization would lie to the
 * model about what the tool returned, so mixed content passes through.
 */
export function extractTextContent(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || (block as any).type !== 'text') return null;
    parts.push(String((block as any).text ?? ''));
  }
  return parts.join('\n');
}

// ── Router-narration hygiene (spike finding 2026-09-20) ──────────────────

/**
 * Removes router cascade narration from machine-facing sub-call output.
 *
 * The router narrates candidate outcomes ("> [router] X — rate limited,
 * trying Y", "> [router] MHINT: …") as text_delta lines into the sub-call
 * stream. Intended for human sessions, pure noise for a summarizer
 * consumer — the live spike saw ~5 KB of narration around a 108-token
 * summary. Strip every line starting with "> [router]" and collapse the
 * blank-line runs they leave behind.
 */
export function stripRouterNarration(text: string): string {
  const kept = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('> [router]'));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Summary prompt ───────────────────────────────────────────────────────

/**
 * Builds the summarization user message. The summarizer must preserve what
 * a coding orchestrator needs for follow-up turns (symbols, paths, values)
 * without pretending line accuracy — exact lines come from targeted
 * re-reads, which delegation never touches.
 */
export function buildSummaryPrompt(raw: string): string {
  return (
    'Summarize the following tool output into at most 10 concise bullet points. ' +
    'Preserve every file path, function/symbol name, identifier, command, key number, and error message ' +
    'exactly as written — the reader is a coding agent that may act on them. ' +
    'Do NOT pad with prose; write only the bullets.\n\n' +
    raw
  );
}

// ── Sub-call stream draining ─────────────────────────────────────────────

/** Minimum stripped output length for a replacement to be trusted. */
const MIN_SUMMARY_CHARS = 50;

interface SubCallOutcome {
  text: string;
  /** Present when the sub-model reported usage (pi-ai Usage shape). */
  usage?: Usage;
}

/**
 * Drains a streamSimple sub-call: accumulates text_delta content and grabs
 * the nested usage (same event shapes the live spike observed — usage rides
 * on stream events / message_end). Throws on error events so callers
 * fail open.
 */
async function drainSubCallStream(stream: AsyncIterable<any>): Promise<SubCallOutcome> {
  let text = '';
  let usage: Usage | undefined;
  for await (const ev of stream) {
    const t = ev?.type;
    if (t === 'text_delta') {
      text += String(ev.delta ?? '');
    } else if (t === 'error') {
      throw new Error(`sub-model stream error: ${String(ev.error ?? 'unknown')}`);
    } else {
      const u = ev?.usage ?? ev?.message?.usage;
      if (u) usage = u;
    }
  }
  const out: SubCallOutcome = { text };
  if (usage) out.usage = usage;
  return out;
}

// ── Targeted-read / piped-bash exemption (shunt, Phase 1) ───────────────

/**
 * A `read` is targeted when the caller already knows the section it needs
 * (offset and/or limit). shunt's check-file-size lets these pass through
 * unblocked — and we let them pass unsummarized — because the orchestrator
 * fetched that window deliberately (often for an edit) and needs the exact
 * lines. Delegating a targeted read only adds latency and destroys the
 * precision an edit requires.
 */
function isTargetedRead(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const i = input as Record<string, unknown>;
  return i.offset != null || i.limit != null;
}

/**
 * A `bash` command is a targeted extract (not a bulk dump) when it pipes
 * output or uses a selective tool (grep/rg/sed/awk). shunt: "Piped commands
 * (cat file | grep) pass through since those are targeted reads." A plain
 * `cat`/`head`/`tail` of a big file is a bulk read and stays delegable.
 */
function isTargetedBash(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const cmd = (input as Record<string, unknown>).command;
  if (typeof cmd !== 'string') return false;
  if (cmd.includes('|')) return true;
  return /\b(?:grep|rg|sed|awk)\b/.test(cmd);
}

// ── The handler ──────────────────────────────────────────────────────────

export interface DelegationOutcome {
  content: Array<{ type: 'text'; text: string }>;
  /** Nested usage for accounting; attached when the sub-model reported one. */
  usage?: Usage;
}

/**
 * tool_result delegation handler. Returns the replacement
 * ({ content, usage }) for an oversized covered tool result, or undefined
 * to pass the original through (every miss and every failure).
 *
 * The replacement is marked so the orchestrating model knows a targeted
 * re-read (offset/limit — never delegated) or a narrower re-run is
 * available for exact content.
 */
export async function handleReadDelegation(
  event: { toolName?: string; content?: unknown; isError?: boolean; input?: unknown },
  ctx: any,
  cfg: Config | undefined,
  log?: (msg: string) => void
): Promise<DelegationOutcome | undefined> {
  try {
    const settings = delegationSettings(cfg);
    if (!settings.enabled) return undefined;
    const tool = typeof event?.toolName === 'string' ? event.toolName : '';
    if (!settings.tools.includes(tool) || event.isError) return undefined;

    // Phase 1: shunt targeted-read / piped-bash exemption. A targeted read
    // (offset/limit) or a piped/grep'd bash command is a selective extract
    // the orchestrator needs exactly — delegating it only adds latency and
    // destroys the precision an edit requires. Mirrors shunt's check-file-size
    // ("Targeted reads pass through") and check-bash-read (pipes pass through).
    if (tool === 'read' && isTargetedRead(event.input)) return undefined;
    if (tool === 'bash' && isTargetedBash(event.input)) return undefined;

    const raw = extractTextContent(event.content);
    if (raw === null || raw.length < settings.min_chars) return undefined;

    // Resolve the delegation group through Pi's public registry API —
    // the router's group interception routes to the cheap model.
    const model = ctx?.modelRegistry?.find?.(settings.group, settings.group);
    if (!model) {
      log?.(`[delegation] group "${settings.group}" not registered — passing through`);
      return undefined;
    }

    const context = {
      messages: [{ role: 'user', content: buildSummaryPrompt(raw.slice(0, settings.max_raw_chars)) }],
    };
    const stream = ctx.modelRegistry.runtime.streamSimple(model, context, { signal: ctx?.signal });
    const { text, usage } = await drainSubCallStream(stream);

    // Narration hygiene (spike finding) + trust check: a cascade that only
    // narrated (all candidates failed) leaves no real summary — pass the
    // ORIGINAL through rather than replacing content with noise.
    const summary = stripRouterNarration(text);
    if (summary.length < MIN_SUMMARY_CHARS) {
      log?.(`[delegation] sub-call produced no usable summary (${summary.length} chars) — passing through`);
      return undefined;
    }

    const replacement =
      `[delegated summary of a ${raw.length}-char ${tool} result — ` +
      `re-read with offset/limit or re-run with narrower output for exact content]\n\n` +
      summary;

    log?.(`[delegation] replaced ${raw.length}-char ${tool} result with ${summary.length}-char summary via ${settings.group}`);
    const outcome: DelegationOutcome = { content: [{ type: 'text', text: replacement }] };
    if (usage) outcome.usage = usage;
    return outcome;
  } catch (err) {
    // Fail-open: the main model must never lose the original result.
    log?.(`[delegation] failed, passing through: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
