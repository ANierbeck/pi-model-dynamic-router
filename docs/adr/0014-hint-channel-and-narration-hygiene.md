# ADR-0014: HINT is the user's channel, MHINT is the router's — and narration never feeds classification

**Status**: Accepted (documented retroactively 2026-09-26). Decisions made
in commits `1b69beb` (1.5.4, lock-in loop fix, 2026-09-18), `c62af57`
(strip narration on all classifier-input paths) and `c9247d5` (MHINT
reserved for router narration, 2026-09-20). Sources:
`src/content-classifier.ts` (`detectHintDirectly`),
`src/classification-prompt.ts`, `src/utils.ts` (`stripRouterNarration`), `src/stream-orchestrator.ts`.

## Context

Users steer the router in chat with `HINT: <model>` or
`HINT: use group <name>`, in English or German, with or without a colon.
The router narrates its own decisions into the visible answer
(`> [router] HINT: mistral/foo · …`). Those lines are stored in the
conversation history.

**Incident 2026-09-18:** on the next turn the classifier received the
previous assistant message, including the narration. It read the router's
own `HINT: <model>` as a fresh user instruction and routed back to the
last-narrated model. This was self-reinforcing. A session stayed stuck on
two free OpenRouter models for many turns.

## Decision Drivers

- The user's HINT must keep working unchanged.
- Router output must never be able to act as a user instruction, whatever
  path it takes back into the input (assistant snippet, previous user
  message, subagent replays of whole conversations).
- The word "hint" in ordinary prose must never trigger routing.

## Options Considered

- **Only strip narration from the assistant snippet** (the first fix,
  `1b69beb`). Insufficient: subagent tasks replay prior turns verbatim
  inside user messages, so narration arrived through other paths.
- **Stop narrating HINT lines.** Loses the user-visible explanation of
  routing decisions.
- **Separate markers + strip on every path + prompt hardening
  (accepted)**, defense in depth.

## Decision

1. **Channel split.** `HINT:` belongs to the user (model or group hints).
   The router narrates model hints as `MHINT:` (`Model-HINT` / `Model_HINT`
   also recognized). MHINT is model-only by definition: a group verb after
   MHINT yields no hint.
2. **Deterministic parsing first.** `detectHintDirectly` handles HINT before
   any LLM runs. It requires HINT as a standalone leading token plus a
   colon or a known verb (`use`, `nutze`, `verwende`, `benutze`). Bare
   nouns (`HINT group x`), empty payloads and incomplete group hints return
   `null` and fall through to classification.
3. **Strip narration on every classifier-input path**: current prompt,
   previous user message, last assistant snippet. Lines matching
   `> [router]` are removed (`stripRouterNarration` in `src/utils.ts`).
4. **Prompt hardening.** The classification prompt scopes the HINT rule to
   the current request only, never to the injected context block.
5. **Cloud fallback guard.** A cloud classifier that echoes a `hint:*`
   category for a prompt without a user HINT is rejected, and the next
   candidate is tried (voxtral incident, 2026-09-26). Probe-time quality
   validation rejects such models up front (ADR-0006).
6. **Hint targets are normalized.** Dots, underscores and case are
   ignored, so `zai-glm-5.3` finds `zai-glm-5-3`.

## Consequences

- Narration can stay verbose for humans without risking control flow.
- Any new path that feeds text to the classifier must call
  `stripRouterNarration`.
- `stripRouterNarration` (`src/utils.ts`) is the single implementation for
  classifier input and for delegation/bulk-read sub-call output. It also
  collapses blank-line runs. The former copy in `src/delegation.ts` was
  removed on 2026-09-26.

Tests pinning this: `hint-classification`, `detect-hint-synonyms`,
`hint-normalization`, `hint-resolution`, `classifier-context-narration-leak`,
`classifier-narration-leak-multi-turn`, `classifier-fallback-chain` (hint
echo), `classifier-fallback-probe` (quality validation), `delegation`
(stripRouterNarration).
