/**
 * Agent-capability tier — curated routing DATA, not a blocklist of shame.
 *
 * GDPval measures benchmark/economics performance, not agentic reliability:
 * the 2026-09-27 incidents showed `mistral-small-*` (slug-resolved GDPval
 * 349–478, passing the `operational` min_gdpval 300 floor) and
 * `magistral-small-*` (GDPval 665, even passing `tactical` 600) serving
 * garbage on MAIN-agent work — 35+ consecutive 0–220-char toolUse turns
 * (pi-model-router-fork session, afternoon) and a final turn that announced
 * "Jetzt liefere ich die Evaluation …" and simply stopped without delivering
 * it (~/private-chat session, 14:36Z). No failure detection can fire on
 * these: the streams finish normally (non-empty, stopReason `stop`).
 *
 * This table encodes the missing capability axis. It is family-prefix-based
 * (new `-latest`/dated variants are covered automatically) and matched
 * against ANY path segment of the model id, so provider re-hosts are covered
 * too (the afternoon incident's first-ranked candidate was
 * `openrouter/mistral/mistral-small-3-2`).
 *
 * Scope (owner decision 2026-09-27): applies to ROUTING GROUPS only, via
 * applyGroupFilters. The prompt classifier chain does NOT go through group
 * filters and deliberately keeps these models — small models are good enough
 * for classification. Additions/withdrawals go through normal commits and
 * review, with evidence in the doc comment.
 */
export const NON_AGENT_MODEL_ID_PREFIXES: readonly string[] = [
  // 2026-09-27, both sessions: passes the 300 GDPval floor (349–478) but
  // produced tool loops and announced-but-undelivered answers.
  'mistral-small-',
  // Small reasoner: GDPval 665 despite — passed even tactical's 600 floor.
  'magistral-small-',
  // 3b/8b/14b tiny models (lowest scanned scores, 15+).
  'ministral-',
  // Audio models serving text turns (fine as classifiers, not as agents).
  'voxtral-',
  // Code-completion family; codestral-2508 is additionally 422-broken via
  // the direct transport.
  'codestral-',
];

/** True if the model id (or ref) may carry main-agent work. */
export function isAgentCapableId(id: string): boolean {
  const segments = id.split('/');
  return !segments.some((seg) =>
    NON_AGENT_MODEL_ID_PREFIXES.some((p) => seg.startsWith(p))
  );
}

/** Ref-aware wrapper: works for 'provider/model' and nested re-host refs. */
export function isAgentCapableRef(ref: string): boolean {
  return isAgentCapableId(ref);
}
