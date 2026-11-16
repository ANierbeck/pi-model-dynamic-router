# Permanent blocklist entries must not expire

**Status:** in progress 2026-11-16 — owner chose option 1 of the admission
question; blocklist and snapshot halves implemented, gates running.

**Verified against:** `main` @ `f9a153c` (merge of PR #182),
  `~/.pi/agent/models-store.json` (written 2026-11-16 21:11 by
  `pi update --models`), `dist/router-config.dynamic.json` (generated
  2026-11-16 20:12:21), `dist/.cache/scan-cache.json` (models_cached
  2026-11-16 19:12:39).

## Problem

Models that the upstream provider has retired stay in the dynamic config
forever and keep being offered as routing candidates.

Live case 2026-11-16: `mistral/open-mistral-nemo` (retired 2026-07-31,
replaced by Ministral 3 8B) and `mistral/devstral-2512` (retired same day,
replaced by Mistral Medium 3.5) were still listed in the `standard`,
`bulk_reader` and `code_writer` groups of `dist/router-config.dynamic.json`
and were still ranked as candidates 3 and 4 in `standard` at 20:16.

Three facts make this possible, and none of them is a router cache bug:

1. **No deprecation signal exists in the data the router sees.** Pi's
   bundled catalog (`pi-ai/dist/providers/data/mistral.json`), the refreshed
   `models-store.json` and Mistral's own model list carry no
   `deprecated`/`retirement` field — verified: the store contains no
   `deprecat` substring at all, and `chat:open-mistral-nemo` has exactly the
   same field set as `chat:mistral-large-latest`. The retirement dates come
   from Mistral's public documentation, not from any API. ADR-0021 makes
   Pi's registry the single source of truth for the cloud inventory, so the
   router admits what Pi offers.
2. **The learned blocklist (ADR-0008) expires even for `permanent`
   verdicts.** `isBlocked()` compares `last_seen` against
   `BLOCKLIST_TTL_MS` (7 days) unconditionally
   (`src/model-blocklist.ts`), so a model blocked for `decommissioned` or
   `free-variant-retired` is re-admitted after a week, fails again and is
   re-blocked — a permanent truth modelled as a temporary one.
3. **The snapshot persist path ignores the blocklist entirely** — by design
   (`src/routing.ts`, comment "a block baked into the persisted config would
   outlive its 7-day TTL"). That rationale is correct for TTL blocks and
   wrong for permanent ones.

A fourth gap is out of scope here: models that were never streamed since
their retirement (the live case) have no failure evidence at all, so no
learned signal can exist yet. Catching those needs an active liveness probe
at scan time — a separate problem, its own plan.

## Solution

Teach the blocklist the difference between a temporary and a permanent
verdict, and let the persist path honour the permanent ones.

1. `BlocklistEntry` gains `permanent?: true`, set by `block()` when
   `classifyFailure()` returned `verdict: 'permanent'` (Tier-1 signatures
   from `src/error-signatures.ts`). Tier-2 promotions
   (`unknown-signature`) stay temporary.
2. `isBlocked()` returns true for a permanent entry regardless of age;
   TTL behaviour for Tier-2 entries is unchanged.
3. New `isPermanentlyBlocked(cache, ref)` for callers that must distinguish
   the two.
4. `activeBlocks()` keeps listing permanent entries past the TTL and reports
   `reprobeInMs: null` for them; `/router blocklist` renders that as
   "permanent" instead of a countdown.
5. `generateDynamicConfig()` drops permanently blocked refs before building
   the snapshot, next to the exclude filter, with its own log line. TTL
   blocks still do not reach the snapshot (the existing rationale holds).
6. `recordBlocklistSuccess()` and `/router blocklist clear` keep working on
   permanent entries: observed success beats a stale verdict, and the owner
   keeps a manual escape hatch.

Derived-only, no model names: the signal is the provider's own error text
(§9-compliant — nothing is admitted, selected, ranked or excluded by name).

## Open decisions

None.

## Out of scope (separate plans)

- Active liveness probe at scan time for models that were never streamed
  since retirement (would have caught the live case without any failure).
- A deprecation feed: Pi publishes none, so there is nothing to consume.
