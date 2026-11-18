# 0035 — An installed Laya leads the classifier chain; without it the standard chain runs

## Status

Accepted (2026-11-18, owner decision). Builds on ADR 0032 (local-first chain,
unchanged) and closes the open decision of the plan
`docs/plans/2026-10-25-laya-sole-classifier.md` about how Laya is used once it
is installed. ADR 0032 is not edited.

## Context

Since 2026-11-14 the order of the classifier chain is fixed in code: Laya (when
enabled and in `active` mode), then the local Ollama chain, then the cloud
chain, then the static rules. The sole-classifier plan (2026-10-25) asked
whether Laya should be the only categorizer. Its open steps were data
collection (disagreement labels, momentum observations, `continue` precision),
and the 2.0.0 release list offered the owner two readings: close the plan as
"stays experimental", or let Laya lead.

The install wizard, however, wrote a fresh `integrations.laya` block in
`shadow` mode. A user who installed Laya therefore got a classifier that only
logged its answers, and the chain still decided every route. That is not the
owner's intent for an installed Laya.

## Decision

1. **An installed Laya leads.** When the user installs Laya through
   `/router laya install`, the block it writes is `mode: "active"`. In that
   mode a Laya answer that passes the confidence gate decides the route.
2. **Without Laya the standard chain runs.** A user who has not installed Laya,
   or who has disabled it, gets the chain of ADR 0032 exactly as before.
3. **Laya's failure is the chain's turn.** When the sidecar is down, times out,
   or its answer is vetoed, the local and cloud chains decide that prompt. This
   is decision 3 of the sole-classifier plan and is unchanged.
4. **A chosen mode is kept.** A reinstall keeps the `mode` already in the user's
   block. A user who wants to watch Laya first sets `"shadow"` and keeps it.
5. **The code default is unchanged.** A hand-written block with `enabled: true`
   and no `mode` still reads as `shadow`. Only the installer's default changes.

## Consequences

- The steps of the sole-classifier plan (3 disagreement labelling, 5 momentum
  observation, 6 `continue` decision) are no longer release gates for 2.0.0.
  Their data keeps being collected in the owner's setup. This is the reading
  the owner's answer was taken to mean; the plan records it.
- New installs route on Laya's answers. That is a behaviour change for anyone
  who installs after this ADR; the CHANGELOG names it.
- The confidence gate (`confidence_threshold`, default 0.8) still applies.
  The sole-classifier plan's decision 1 ("no confidence gate") was never
  implemented that way, and this ADR does not change it.

## Open

- The default confidence gate. The shipped value 0.8 is uncalibrated (ECE 0.466
  in the spike). The owner's own block uses `0`. Whether the shipped default
  should follow decision 1 of the plan is an owner choice; see `TODO.md`.
