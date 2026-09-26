/**
 * bulk_read tool + read pre-call block (ADR-0007, revised 2026-09-20):
 * the shunt Layer 1+2 equivalent — shunt (Spotify's Portal plugin) blocks
 * oversized full-file reads pre-execution and redirects to a cheap
 * bulk-reader that answers questions ABOUT files, so the raw content never
 * enters the expensive model's context at all.
 *
 *   Layer 1 (checkReadBlock): a full-file `read` (no offset/limit) of a file
 *   above `delegation.block_lines` (default 350, shunt's SHUNT_MIN_LINES) is
 *   blocked with a reason that redirects to bulk_read or a targeted read.
 *   Targeted reads pass — the model already knows the section it needs.
 *
 *   Layer 2 (executeBulkRead): the bulk_read tool reads the files from disk
 *   ITSELF, sends question + content to the delegation group (bulk_reader)
 *   via Pi's public registry API, and returns only the concise answer. The
 *   orchestrator pays for the answer, never for the corpus.
 *
 * Deliberate divergence from shunt: bash is NOT pre-blocked. shunt's
 * check-bash-read parses commands for cat/head/tail on big files, but a
 * bash command string is far more brittle to parse than a read input
 * (pipes, globs, subshells). The tool_result shrinker already covers bash
 * post-hoc; pre-blocking stays read-only.
 *
 * Error semantics follow Pi's custom-tool contract: failures THROW from
 * executeBulkRead (Pi marks the result isError:true and reports it to the
 * LLM, which can fall back to a targeted read). The only silent path is
 * checkReadBlock, which fails OPEN like the shrinker — never block what
 * you cannot confidently assess.
 */

import fs from 'node:fs';
import type { Config } from './types.ts';
import {
  delegationSettings,
  type DelegationSettings,
  isTargetedReadInput,
  stripRouterNarration,
  drainSubCallStream,
} from './delegation.ts';

// ── line counting ────────────────────────────────────────────────────────

/**
 * Counts lines in text. A trailing newline does not start a new line:
 * 'a\nb\n' is 2 lines, 'a\nb' is 2 lines, '' is 0, 'only' is 1.
 */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

// ── prompt building (shunt bulk-reader mode instructions) ─────────────────

export interface BulkReadFile {
  path: string;
  content: string;
}

/**
 * Builds the bulk_reader user message: the caller's question plus the files
 * wrapped in XML tags with clear boundaries (shunt's bulk-read does exactly
 * this), under shunt's bulk-reader mode instructions — structured bullets
 * only, no prose, lead with exact names/types/line numbers, skip unasked
 * content.
 */
export function buildBulkReadPrompt(question: string, files: BulkReadFile[]): string {
  const body = files.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`).join('\n');
  return (
    'You are a precise code analyst. Read the provided files and answer the question ' +
    'concisely. Output structured bullets only — no greetings, no prose, no preambles. ' +
    'Lead every bullet with the exact name, type, or line number. Use nested bullets for ' +
    'details. Skip anything the caller did not ask for.\n\n' +
    `Question: ${question}\n\n${body}`
  );
}

// ── Layer 1: pre-call read block (shunt check-file-size) ──────────────────

export interface ReadBlockResult {
  block: true;
  reason: string;
  /** True when the block fired because of the expensive-model escalation
   *  (not the size threshold) — lets the tool_call hook log the cause. */
  expensive?: boolean;
}

/**
 * Whether `ref` belongs to a delegation-expensive group (default:
 * strategic, tactical) or sits behind an expensive provider prefix
 * (default: none). Expensive models never do full-file reads — they
 * orchestrate; file inspection belongs to the cheap delegation group.
 *
 * Group membership is matched against the ACTIVE config's materialized
 * model lists (the scan writes model_groups.<name>.models; entries are
 * plain refs, { ref } objects are tolerated defensively). A config
 * without materialized lists (static-only) matches nothing — fail-open,
 * the size threshold keeps protecting on its own.
 */
export function isExpensiveModelRef(
  ref: string,
  cfg: Config | undefined,
  settings: DelegationSettings
): boolean {
  if (!ref) return false;
  const groups = cfg?.model_groups;
  for (const name of settings.expensive_groups) {
    const models = (groups as Record<string, { models?: unknown }> | undefined)?.[name]?.models;
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      const r = typeof m === 'string' ? m : (m as { ref?: unknown })?.ref;
      if (r === ref) return true;
    }
  }
  for (const prefix of settings.expensive_providers) {
    if (ref === prefix || ref.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) return true;
  }
  return false;
}

/**
 * Pre-call block for full-file reads (tool_call handler in index.ts).
 * Returns { block, reason } when the read should be shunted to bulk_read /
 * a targeted read; undefined when it passes.
 *
 * Fail-open like the shrinker: disabled feature, block_lines 0, non-read
 * tools, targeted reads, missing/unstatted files — everything passes. A
 * read we cannot assess must never be blocked.
 */
export function checkReadBlock(
  event: { toolName?: string; input?: unknown },
  cfg: Config | undefined,
  curModel?: string
): ReadBlockResult | undefined {
  try {
    const settings = delegationSettings(cfg);
    if (!settings.enabled || settings.block_lines <= 0) return undefined;
    if (event?.toolName !== 'read') return undefined;
    if (isTargetedReadInput(event.input)) return undefined;

    const input = event.input as Record<string, unknown> | undefined;
    const p = input?.path;
    if (typeof p !== 'string' || p.length === 0) return undefined;

    let size: number;
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return undefined;
      size = st.size;
    } catch {
      return undefined; // nonexistent file: the read tool reports that itself
    }

    // ADR-0007 escalation (2026-09-26): members of expensive groups
    // (default strategic/tactical) never read full files, regardless of
    // size — their context is paid for orchestration, file inspection
    // goes to the cheap delegation group. Sits AFTER the stat check
    // (fail-open: a read we cannot assess is never blocked) and BEFORE
    // the size prefilter (expensive blocks fire at any size). Targeted
    // reads passed above; an unknown curModel falls through to size-only.
    if (curModel && isExpensiveModelRef(curModel, cfg, settings)) {
      return {
        block: true,
        expensive: true,
        reason:
          `Full-file reads are blocked for expensive models (${curModel}) — keep your context for ` +
          `orchestration and reasoning. Use the bulk_read tool with { question, paths } — a cheap ` +
          `reader answers without loading the file into your context. For a specific section use ` +
          `read with offset/limit — targeted reads are never blocked.`,
      };
    }

    // Cheap prefilter: N lines need at least N-1 newline bytes, so a file
    // smaller than block_lines can never reach the threshold.
    if (size < settings.block_lines) return undefined;

    const lines = countLines(fs.readFileSync(p, 'utf8'));
    if (lines <= settings.block_lines) return undefined;

    const reason =
      `File has ${lines} lines (block threshold ${settings.block_lines}). ` +
      `For questions about its content use the bulk_read tool with { question, paths } — ` +
      `a cheap reader answers without loading the file into your context. ` +
      `For a specific section use read with offset/limit — targeted reads are never blocked or summarized.`;
    return { block: true, reason };
  } catch {
    return undefined; // fail-open: never block what we cannot assess
  }
}

// ── Layer 2: bulk_read tool execution (shunt bulk-read script) ─────────────

export interface BulkReadParams {
  question: string;
  paths: string[];
}

export interface BulkReadOutcome {
  content: Array<{ type: 'text'; text: string }>;
  /** Nested sub-model usage for accounting (Pi persists it on the result). */
  usage?: any;
}

/** Reads the requested files from disk, honoring the max_raw_chars cap. */
function loadFiles(paths: string[], maxRawChars: number): BulkReadFile[] {
  const files: BulkReadFile[] = [];
  let budget = maxRawChars;
  let truncated = false;
  for (const p of paths) {
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (err) {
      throw new Error(`bulk_read: cannot read "${p}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (budget <= 0) {
      truncated = true;
      break;
    }
    if (text.length > budget) {
      files.push({ path: p, content: text.slice(0, budget) });
      truncated = true;
      budget = 0;
    } else {
      files.push({ path: p, content: text });
      budget -= text.length;
    }
  }
  if (truncated) {
    files.push({
      path: '(system notice)',
      content:
        'NOTE: the total raw content exceeded the delegation max_raw_chars cap and was ' +
        'truncated. Files listed after the cut were not read — say so if asked about them.',
    });
  }
  return files;
}

/**
 * Executes the bulk_read tool call: question + paths in, concise answer out.
 * The raw file content goes ONLY to the delegation group model; the returned
 * text is the answer alone. Failures throw (Pi marks the result as an error
 * and the orchestrator falls back to targeted reads).
 */
export async function executeBulkRead(
  params: BulkReadParams,
  ctx: any,
  cfg: Config | undefined,
  log?: (msg: string) => void
): Promise<BulkReadOutcome> {
  const settings = delegationSettings(cfg);
  if (!settings.enabled) throw new Error('bulk_read: delegation is disabled in the router config');

  const question = typeof params?.question === 'string' ? params.question.trim() : '';
  const paths = Array.isArray(params?.paths)
    ? params.paths.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  if (!question) throw new Error('bulk_read: a question is required');
  if (paths.length === 0) throw new Error('bulk_read: at least one readable file path is required');

  const files = loadFiles(paths, settings.max_raw_chars);
  if (files.length === 0) throw new Error('bulk_read: no files could be read');

  // Resolve the delegation group through Pi's public registry API — the
  // router's group interception routes to the cheap model.
  const model = ctx?.modelRegistry?.find?.(settings.group, settings.group);
  if (!model) throw new Error(`bulk_read: delegation group "${settings.group}" is not registered`);

  const context = {
    messages: [{ role: 'user', content: buildBulkReadPrompt(question, files) }],
  };
  const stream = ctx.modelRegistry.runtime.streamSimple(model, context, { signal: ctx?.signal });
  const { text, usage } = await drainSubCallStream(stream);

  // Router-narration hygiene (same as the shrinker): a cascade that only
  // narrated leaves no real answer. Unlike the shrinker there is no original
  // to fall back to — an empty answer is a thrown error, not a silent lie.
  const answer = stripRouterNarration(text);
  if (answer.trim().length === 0) {
    log?.(`[bulk_read] sub-call produced no usable answer — reporting error`);
    throw new Error('bulk_read: the reader model returned no usable answer; use a targeted read instead');
  }

  log?.(
    `[bulk_read] answered "${question.slice(0, 60)}" from ${paths.length} file(s), ` +
      `answer ${answer.length} chars via ${settings.group}`
  );
  const outcome: BulkReadOutcome = { content: [{ type: 'text', text: answer }] };
  if (usage) outcome.usage = usage;
  return outcome;
}
