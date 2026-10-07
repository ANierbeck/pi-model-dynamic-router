// src/classifier-local-probe.ts
// Derived local classifier chain (ADR-0025 Phase C) — the local counterpart of
// classifier-fallback-probe.ts's cloud derivation.
//
// WHY: the local leg of the classifier used to be a shipped pair of model
// names (a primary and a fallback). That is a claim about somebody else's
// machine, made in the single most consequential selection the router makes —
// which model judges every prompt. Here the chain is derived instead:
//
//   1. CANDIDATES — the Ollama models the scan found (cache.available_models),
//      minus embedding-only / non-completion models (capabilities extracted
//      from /api/show), minus models marked as rejecting structured output
//      (classifier_no_schema, 24h TTL), minus excluded and blocklisted refs.
//      Order: parameter size ascending (small = fast; the size Ollama reported
//      wins over one parsed from the id), size-unknown models after the sized
//      ones, name as the stable tiebreak.
//   2. PROBE — each candidate must classify the shared PROBE_CASES (the same
//      prompt surface and golden set the cloud probe uses) through the same
//      callOllama path the runtime uses. A 501 "structured output is
//      unavailable" is a permanent backend property: the model is skipped AND
//      marked in cache.classifier_no_schema. The ordered working list is
//      persisted as cache.classifier_local_models.
//   3. RESOLUTION at classification time — user pin (classifier_model /
//      classifier_fallback in the dynamic group, optional) › probed list ›
//      provisional (the candidate order itself, before the first probe) ›
//      nothing (the local leg is skipped; the chain continues with cloud and
//      the static classifier).

import type { Cache, Config } from './types.ts';
import { isExcluded } from './exclude.ts';
import { isBlocked } from './model-blocklist.ts';
import { isProviderWedged } from './provider-watchdog.ts';
import { PROBE_CASES, judgeProbeReply } from './classifier-fallback-probe.ts';
import { buildClassificationPrompt } from './classification-prompt.ts';

/** Generous cold-start bound for a local model (also the runtime primary timeout). */
export const LOCAL_CLASSIFIER_TIMEOUT_MS = 45_000;

/**
 * Probe bounds. Local generations cost GPU time and a wedge-prone daemon, so
 * the discipline is tighter than the cloud probe's: only the smallest few
 * candidates are tried and the probe stops once a primary + fallback exist.
 */
const MAX_LOCAL_PROBE_CANDIDATES = 6;
const MAX_LOCAL_WORKING_MODELS = 3;
/**
 * A scan runs on every session start but a probe costs GPU time (3 cases per
 * candidate), so a persisted result is reused until the candidate set changes,
 * a forced scan asks for a fresh one, or this TTL lapses.
 */
const LOCAL_PROBE_TTL_MS = 24 * 60 * 60_000;

// ── No-structured-output marks (live incident 2026-09-26) ──────────────────
// Ollama's MLX backend answers JSON-schema calls with HTTP 501
// "structured output is unavailable" — a permanent property of the backend,
// not a transient failure. The observation is persisted so the model is not
// retried on every prompt; the TTL keeps the mark self-healing (an Ollama
// upgrade that adds schema support gets the model retried after expiry).
export const NO_SCHEMA_MARKER = 'structured output is unavailable';
const CLASSIFIER_NO_SCHEMA_TTL_MS = 24 * 60 * 60_000; // 24h

/** True if the local model is marked as rejecting structured output (within TTL). */
export function isMarkedNoSchema(cache: Cache | undefined, model: string): boolean {
  const ts = cache?.classifier_no_schema?.[model];
  return typeof ts === 'number' && Date.now() - ts < CLASSIFIER_NO_SCHEMA_TTL_MS;
}

/** Persist a 501 "structured output is unavailable" observation in the cache. */
export function markNoSchema(cache: Cache | undefined, model: string): void {
  if (!cache) return; // no cache to persist into — the 501 hop just repeats this session
  if (!cache.classifier_no_schema) cache.classifier_no_schema = {};
  cache.classifier_no_schema[model] = Date.now();
}

// ── Candidate selection ─────────────────────────────────────────────────────

/** Parameter count in billions: what Ollama reported, else the `<n>b` tag in the id. */
export function parameterSizeB(model: { id: string; capabilities?: { parameterSizeB?: number } }): number | undefined {
  const reported = model.capabilities?.parameterSizeB;
  if (typeof reported === 'number') return reported;
  const m = /(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)b(?![A-Za-z0-9])/i.exec(model.id);
  return m ? parseFloat(m[1]) : undefined;
}

/** Embedding-only and non-completion models can never answer a chat prompt; unknown capability stays eligible. */
export function isCompletionCapable(model: { capabilities?: { completion?: boolean; embedding?: boolean } }): boolean {
  return model.capabilities?.embedding !== true && model.capabilities?.completion !== false;
}

/**
 * Local (Ollama) model names that may classify, best-first: sized ascending,
 * then size-unknown by name. Pure derivation from the scan cache — it names
 * no model and verifies nothing (see {@link probeLocalClassifierCandidates}).
 */
export function selectLocalClassifierCandidates(cache: Cache, cfg?: Config): string[] {
  const exCtx = cfg?.exclude ? { rules: cfg.exclude, cfg, cache } : undefined;
  return (cache.available_models ?? [])
    .filter((m) => m.provider === 'ollama' && m.id)
    .filter(isCompletionCapable)
    .filter((m) => !isMarkedNoSchema(cache, m.id))
    .filter((m) => !isBlocked(cache, `ollama/${m.id}`))
    .filter((m) => !(exCtx && isExcluded(`ollama/${m.id}`, exCtx)))
    .map((m) => ({ id: m.id, size: parameterSizeB(m) }))
    .sort((a, b) => {
      if (a.size !== undefined && b.size !== undefined && a.size !== b.size) return a.size - b.size;
      if ((a.size === undefined) !== (b.size === undefined)) return a.size === undefined ? 1 : -1;
      return a.id.localeCompare(b.id);
    })
    .map((m) => m.id);
}

// ── Probe ───────────────────────────────────────────────────────────────────

/** The hooks the local probe needs — injected so tests (and the scan) wire the real client. */
export interface LocalProbeDeps {
  callOllama: (model: string, prompt: string, options: { timeoutMs: number }) => Promise<string>;
  /** Daemon reachability. Optional and fail-open: omitted = assume up. */
  isAvailable?: () => Promise<boolean>;
}

/**
 * Probes the derived candidates with the shared classification cases and
 * persists the working list (smallest first) as cache.classifier_local_models.
 *
 * Skipped without touching the previous list when the daemon is unreachable
 * or the watchdog marks it wedged — an outage must not wipe a good chain.
 * With no candidates the persisted list is empty and nothing is called.
 * A fresh persisted result for the same candidates is reused (no GPU time)
 * unless `opts.force` (an explicit `/router scan`) asks for a re-probe.
 *
 * @returns the working model names (also written to the cache).
 */
export async function probeLocalClassifierCandidates(
  cfg: Config,
  cache: Cache,
  deps: LocalProbeDeps,
  onLog?: (msg: string) => void,
  opts: { force?: boolean } = {},
): Promise<string[]> {
  const log = onLog ?? (() => {});
  const candidates = selectLocalClassifierCandidates(cache, cfg).slice(0, MAX_LOCAL_PROBE_CANDIDATES);
  const previous = cache.classifier_local_probe;
  if (
    !opts.force &&
    Array.isArray(cache.classifier_local_models) &&
    previous &&
    Date.now() - previous.at < LOCAL_PROBE_TTL_MS &&
    previous.candidates.join('\n') === candidates.join('\n')
  ) {
    return cache.classifier_local_models;
  }
  if (candidates.length === 0) {
    cache.classifier_local_models = [];
    log('[classifier-local-probe] no local classifier candidates (no completion-capable Ollama model)');
    return [];
  }
  if (isProviderWedged(cache, 'ollama') || (deps.isAvailable && !(await deps.isAvailable()))) {
    log('[classifier-local-probe] Ollama unreachable or wedged — keeping the previous local classifier list');
    return cache.classifier_local_models ?? [];
  }
  log(`[classifier-local-probe] probing ${candidates.length} local candidate(s)`);

  const working: string[] = [];
  for (const model of candidates) {
    if (working.length >= MAX_LOCAL_WORKING_MODELS) break;
    let failReason = '';
    for (const tc of PROBE_CASES) {
      const prompt = buildClassificationPrompt(tc.prompt, tc.contextBlock ?? '');
      try {
        const raw = await deps.callOllama(model, prompt, { timeoutMs: LOCAL_CLASSIFIER_TIMEOUT_MS });
        const verdict = judgeProbeReply(raw, tc);
        if (!verdict.ok) {
          failReason = `${tc.name}: ${verdict.reason}`;
          break;
        }
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (msg.includes(NO_SCHEMA_MARKER)) markNoSchema(cache, model);
        failReason = `${tc.name}: ${msg}`;
        break;
      }
    }
    if (failReason) {
      log(`[classifier-local-probe] ${model} failed: ${failReason}`);
      continue;
    }
    // It answered the schema-constrained probe: an expired 501 mark is stale.
    if (cache.classifier_no_schema) delete cache.classifier_no_schema[model];
    working.push(model);
    log(`[classifier-local-probe] ${model} OK`);
  }

  cache.classifier_local_models = working;
  cache.classifier_local_probe = { at: Date.now(), candidates };
  log(`[classifier-local-probe] ${working.length} working local model(s) cached: ${working.join(', ') || '(none)'}`);
  return working;
}

// ── Resolution at classification time ───────────────────────────────────────

/**
 * The user's optional local pins from a dynamic group (`classifier_model` /
 * `classifier_fallback`, no shipped value), as bare Ollama model names.
 */
export function localClassifierPins(
  group: { classifier_model?: string; classifier_fallback?: string } | undefined,
): { model?: string; fallbackModel?: string } {
  const bare = (ref: string) => ref.replace(/^ollama\//, '');
  return {
    ...(group?.classifier_model ? { model: bare(group.classifier_model) } : {}),
    ...(group?.classifier_fallback ? { fallbackModel: bare(group.classifier_fallback) } : {}),
  };
}

export interface LocalClassifierChain {
  primary?: string;
  fallback?: string;
}

/**
 * The local primary/fallback for one classification: user pin per slot ›
 * probed list › provisional candidate order › nothing. A pin is never
 * duplicated into the other slot, and derived entries marked no-schema after
 * the probe ran are skipped. An empty result means: skip the local leg.
 */
export function resolveLocalClassifierChain(
  cache: Cache | undefined,
  cfg: Config | undefined,
  pins: { model?: string; fallbackModel?: string } = {},
): LocalClassifierChain {
  const probed = (cache?.classifier_local_models ?? []).filter((m) => !isMarkedNoSchema(cache, m));
  const pool = probed.length > 0 ? probed : cache ? selectLocalClassifierCandidates(cache, cfg) : [];
  const primary = pins.model ?? pool.find((m) => m !== pins.fallbackModel);
  const fallback = pins.fallbackModel ?? pool.find((m) => m !== primary);
  return {
    ...(primary ? { primary } : {}),
    ...(fallback ? { fallback } : {}),
  };
}
