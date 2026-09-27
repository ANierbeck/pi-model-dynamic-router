/**
 * Agent-capability tier — config-driven routing DATA, not a blocklist of shame.
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
 * The curated family list lives in the config key `non_agent_model_prefixes`
 * (Config, src/types.ts) — the owner's requirement (2026-09-27 evening): the
 * tier must be configurable identically for all users, in the normal config
 * layers. The embedded router-config.json ships the default list; user and
 * project layers REPLACE it (standard array semantics — set the full list
 * you want). An absent or empty key is an EXPLICIT off-switch.
 *
 * Matching is family-prefix-based (new `-latest`/dated variants are covered
 * automatically) against ANY path segment of the model id, so provider
 * re-hosts are covered too (the afternoon incident's first-ranked candidate
 * was `openrouter/mistral/mistral-small-3-2`).
 *
 * Scope (owner decision 2026-09-27): applies to ROUTING GROUPS only, via
 * applyGroupFilters. The prompt classifier chain does NOT go through group
 * filters and deliberately keeps these models — small models are good enough
 * for classification. Additions/withdrawals go through normal config edits
 * and review, with evidence kept in this doc comment.
 */

/** True if any path segment of the model id starts with one of the prefixes. */
export function segmentsMatchingPrefix(id: string, prefixes: readonly string[]): boolean {
  const segments = id.split('/');
  return segments.some((seg) => prefixes.some((p) => seg.startsWith(p)));
}

/**
 * True if the model ref may carry main-agent work under the given prefixes.
 * An absent or empty prefix list is an explicit off-switch (no filtering).
 */
export function isAgentCapableRef(ref: string, prefixes?: readonly string[]): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  return !segmentsMatchingPrefix(ref, prefixes);
}
