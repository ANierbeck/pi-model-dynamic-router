# 0031 — Withdraw multi-label classification (ADR 0001 is not pursued)

## Status

Accepted (2026-11-14, owner decision). Withdraws the plan of ADR 0001
(Option C, accepted 2026-08-29, not implemented). ADR 0001 itself is not
changed; this ADR records the reversal.

## Context

ADR 0001 accepted a weighted multi-label classification: one prompt may carry
several categories, and the router combines their requirements. It was never
built. Its open item in `TODO.md` said "needs an ADR before implementation",
which had been true in August and had gone stale.

Since then the category source has changed. The owner uses the Laya classifier
in daily work and reports that routing follows Laya's category alone (owner
statement, 2026-10-31). Laya returns one category per prompt
(`laya-sidecar/src/classify.ts`, single `category` answer).

On 2026-11-14 the owner decided that multi-label is not sensible with Laya.

## Decision

Multi-label classification is withdrawn. No plan is started, and the TODO entry
is removed. The mitigation plan of ADR 0001 is void with it.

If the owner wants multi-label again, that is a new ADR that cites ADR 0001 and
this one, and it must be designed against the Laya output format, not the
pre-Laya classifier.

## Consequences

- No code change. ADR 0001 stays in the record as history.
- `TODO.md` no longer lists multi-label.
- The "silent misrouting" risk that ADR 0001 described is out of scope.
