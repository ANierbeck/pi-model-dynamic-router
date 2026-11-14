# 0033 — Opt-in escalation of low-confidence local replies to the cloud chain

## Status

Accepted (2026-11-14, owner decision). Resolves the first open point of
ADR 0032 (`docs/adr/0032-local-first-classifier-chain.md`): a local reply below
the confidence gate is not final by default. ADR 0032 is not changed.

## Context

ADR 0032 made a usable local answer final. A local reply below the confidence
gate (MIN_CONFIDENCE 0.5) was final too, and it inherited the previous turn's
category or fell back to `continue`. Two readings were open: escalate such
replies to the cloud chain automatically, or never escalate. The owner decided
that escalation must be configurable and must not happen automatically for end
users, since it sends prompt text to a cloud model.

## Decision

1. **New key** `model_groups.dynamic.classifier_escalate_low_confidence`
   (boolean, default off, set in `router-config.user.json`).
2. **Behaviour when on.** A local reply below MIN_CONFIDENCE is escalated once to
   the cloud chain, which runs only when `classifier_cloud_chain` is also on.
   - A cloud answer replaces the local reply.
   - If the cloud chain produces nothing, the gated local reply is kept.
3. **Behaviour when off (default).** The local reply stays final, as in ADR 0032.
   No cloud call is made for low confidence.
4. The threshold is the existing MIN_CONFIDENCE (0.5). A separate threshold key
   is not added.

## Consequences

- Default users see no change from ADR 0032: prompt text leaves the machine only
  when no local model answers.
- Users who prefer answer quality over locality opt in explicitly. The cost is
  that low-confidence prompts then reach a cloud model.
- Escalation is attempted at most once per prompt; it does not loop.

## Open

- Whether cloud candidates should be limited to free models again (price ceiling
  as the only eligibility gate). Tracked in `TODO.md`.
