# 0037 — Drop the `<group>:use-static` variant and the keyword static classifier

## Status

Accepted (2026-11-21, owner decision). Reverses the static-fallback part of ADR
0032 (the local-first chain's last resort) and the `:use-static` variant that
ADR 0034 names in its key table. ADR 0032 and ADR 0034 are not edited.

## Context

ADR 0032 kept a keyword classifier (`classifyStatically`) as the last resort of
the classifier chain. It ran only for a `<group>:use-static` model, the variant
the router registered next to every group. A plain group answered `continue`
when every hop failed.

The logs show the keyword classifier has been dormant for months: 662 static
classifications between 2026-08-23 and 2026-09-26, none after that, and no
session file names a `:use-static` model as its model.

The virtual-model migration (`docs/plans/2026-11-21-virtual-models-migration.md`)
makes `router/dynamic` the selection. `route()` never returns the variant, so
after step 2 the variant was registered but unreachable.

## Decision

1. The `<group>:use-static` variant is no longer registered. Each group has one
   catalog entry.
2. `classifyStatically` and the `allowStaticFallback` option are removed. When
   every classifier hop fails, the answer is `continue` with confidence 0 and
   the reason `no classifier answered`.
3. The `static` step is removed from the classifier chain (`/router config`,
   the generated config reference and the routing-flow diagram).
4. The legacy session restore still recognises a `<group>:use-static` branch
   selection, and only there, so that a session from before the migration moves
   to `router/dynamic`.

## Consequences

- The keyword table and its tests are gone. Classification quality without any
  classifier answer is `continue` (routed to `standard`), the same category a
  plain group already gave.
- Users who never used `:use-static` see no change in routing.
- Old sessions on a `:use-static` model migrate on their next start.
