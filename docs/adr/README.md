# Architecture Decision Records

This directory holds ADRs for non-trivial design decisions in the router —
especially ones where the "why not X instead" would otherwise be lost and
someone (very possibly future us) re-litigates the same trade-off from
scratch in a few months.

## When to write one

- Before starting a multi-day feature with more than one plausible design.
- When a decision has a real, documented alternative that was rejected —
  the rejection reason is the valuable part, not the decision itself.

Small, obviously-correct fixes (bug fixes, wiring gaps, config corrections)
don't need an ADR — a good commit message covers those. See `AGENTS.md` §5
for commit conventions.

## Format

Each ADR is a numbered file: `NNNN-title-in-kebab-case.md`, containing:

- **Status** — proposed / accepted / rejected / superseded
- **Context** — what problem exists, what's already in place
- **Decision Drivers** — the constraints that matter for THIS decision
  (single-user deployment, privacy, existing failure-recovery patterns, etc.)
- **Options Considered** — each with pros/cons, not just the winner
- **Decision** — which option, and why (the "why" is the point)
- **Consequences** — what this makes easier/harder going forward

## Index

- [0001 — Multi-label classification](0001-multi-label-classification.md)
- [0002 — Learning from user feedback](0002-learning-from-user-feedback.md)
- [0003 — Reject live subscription-usage-API querying](0003-reject-live-subscription-usage-api.md)
- [0004 — Use pi's `modelRegistry` for cloud classification fallback](0004-cloud-fallback-via-pi-modelregistry.md)
- [0005 — `registerProvider` replaces (not merges) — Ü1 guard design](0005-registerprovider-replaces-not-merges.md)
- [0006 — Probe-based discovery for classifier cloud fallback](0006-probe-based-classifier-fallback-discovery.md)
- [0007 — Task decomposition and delegation](0007-task-decomposition-and-delegation.md)
- [0008 — Learned model blocklist (auto-block from observed permanent failures)](0008-learned-model-blocklist.md) *(Tier 1 implemented)*
- [0009 — Union-merge for `exclude.*` arrays; bundled classifier model as source of truth](0009-exclude-union-merge-and-config-classifier-model.md)
- [0010 — One group-filter rule set for persist, live and display](0010-two-group-filter-pipelines.md)
- [0011 — Registry-first pricing, the free definition, and unknown-cost semantics](0011-registry-first-pricing-and-cost-semantics.md)
- [0012 — Model identity: slug resolution tiers and canonical cluster dedup](0012-model-identity-slug-resolution-and-dedup.md)
- [0013 — Failure classification and failover in stream orchestration](0013-failure-classification-and-failover.md)
- [0014 — HINT is the user's channel, MHINT is the router's; narration never feeds classification](0014-hint-channel-and-narration-hygiene.md)
- [0015 — Test architecture: regression-first suite, per-file state and home isolation](0015-test-architecture.md)
