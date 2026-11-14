# 0032 — Local-first classifier chain: Ollama answers first, cloud is the fallback

## Status

Accepted (2026-11-14, owner decision). Reverses the candidate order of the
cloud-first design of 2026-09-27
(`docs/plans/2026-09-27-cloud-first-local-fallback-plan.md`): the cloud chain
now runs after the local chain, not before it. ADR 0004 (cloud classification
through pi's `completeSimple`) and ADR 0027 (decision log) are not changed; this
ADR changes only the order and the default data flow that follows from it.

## Context

Since 2026-09-27 the classifier ran the cloud chain first on every prompt
whenever `classifier_cloud_chain` was on, and the shipped `dynamic` group turns
it on. The raw prompt text therefore went to a cloud model before any local
model was asked. The candidates are not limited to free models: pinned
`classifier_cloud_model`, the scan-time probe-verified list, lazy discovery over
Pi's model registry (output price at most $5 per million tokens, or a $0 catalog
placeholder), and finally `free_models`.

The docs sync of 2026-11-14 found that the README and PI.md described the
opposite (local, cloud off by default). The owner decided that the shipped
default should stay on the cloud chain but run the local chain first, so that
prompts stay on the machine whenever a local model can answer.

## Decision

1. **Order of the LLM chain.** Laya (opt-in, loopback only) runs as before.
   Then the local Ollama chain: pinned `classifier_model` / `classifier_fallback`,
   else the probe-verified local list. Only when the local leg produces no answer
   (daemon down, no local model, every local hop failed) does the cloud chain run,
   and only when `classifier_cloud_chain` is on. If the cloud chain also produces
   nothing, the static keyword classifier runs when `allowStaticFallback` is
   enabled; otherwise the classification falls back to the `continue` category.
2. **Shipped default.** `classifier_cloud_chain: true` stays on the shipped
   `dynamic` group. Its meaning changes from "cloud first" to "cloud as the
   fallback after the local chain". Users who want no prompt text outside the
   machine set `classifier_cloud_chain: false` on the `dynamic` group in
   `router-config.user.json`.
3. **Status line.** `/router` shows the chain in execution order: Laya, Ollama,
   cloud, static.

## Consequences

- A usable local answer is final. The cloud chain is not asked for it, so the
  prompt text leaves the machine only when no local model answers.
- Cloud cost and data exposure now occur only during a local outage or for
  prompts that every local hop failed on.
- The pinned `classifier_cloud_model` is tried only after the local leg produced
  no answer. It no longer pre-empts the local chain.
- A low-confidence local reply is also final for the cloud chain. Whether it
  should escalate to the cloud is an open question (see `TODO.md`).

## Open

- Escalation of low-confidence local replies to the cloud chain.
- Whether cloud candidates should be limited to free models again (the current
  price ceiling is the only eligibility gate). See `TODO.md`.
