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
