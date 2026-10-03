# ADR-0018: HINT Mechanism Repair (HINT/MHINT/MODEL-HINT prefix)

## Status

Draft (2026-09-27)

## Context / Problem

Achim reported on 2026-09-27: the HINT mechanism no longer works as expected. The mechanism is based on:

- **HINT/MHINT/MODEL-HINT prefix** in the prompt (e.g. `HINT: ...` or `MHINT: ...`)
- **Detection** in `src/content-classifier.ts` via `detectHintDirectly` / `containsHintMarker`
- **Action:** on HINT detection, classification is suppressed and the response is emitted to the user as `HINT: ...` instead of a regular response.

**Symptoms:**

- HINT prefixes are not recognized.
- Classification runs through even though a HINT is present.
- The user does not see the HINT response as such, but as a regular response.

**Background:**

The mechanism surfaced during cloud-first/Ollama planning but is a **separate, independent problem** from the router architecture. It worked in the past (roborev job 345 HIGH, 2026-09-02) but is currently broken.

## Decision

We repair the HINT mechanism by:

1. **Reproducing** the failure (test case with a HINT prefix in the prompt).
2. **Analyzing the root cause** (code review of `detectHintDirectly` / `containsHintMarker` and the classification chain).
3. **Implementing the fix** (code change + regression test).
4. **Finalizing this ADR** (if design/architecture changes become necessary).

## Consequences

- **Positive:** the HINT mechanism works again — better UX for HINT-based workflows.
- **Negative:** small code change in `src/content-classifier.ts`; regression test required.
- **Risk:** none — the mechanism is optional; when broken, the behavior degrades to "normal classification" (no abort).

## Details

### Current implementation (excerpt)

- `src/content-classifier.ts`:
  - `detectHintDirectly(text: string): boolean`
  - `containsHintMarker(text: string): boolean`
  - `classifyPrompt()` uses these functions to detect HINT and suppress classification.
- `src/classification-prompt.ts` / `src/classifier-fallback-probe.ts` contain HINT-detection logic.

### Candidate root causes (suspect list)

1. **Narration leak:** router messages (e.g. `> [router] HINT: ...`) leak into the prompt and distort HINT detection (2026-09-18 lock-in loop — fixed in 662501a, but a regression is possible).
2. **Classifier chain change:** the cloud-first change (Sept 2026) reordered the candidate chain — HINT detection might run at the wrong point.
3. **Prompt extraction:** `extractLastUserPrompt` or `extractLastAssistantSnippet` might strip or mask HINT prefixes.
4. **HINT prefix not in the user prompt:** HINT might live in another field (e.g. the system prompt) and never reach the user-prompt detection.
5. **Faulty match logic:** `detectHintDirectly` matches `/HINT[:\s]/i` — new prompt formatting might defeat the pattern.

### Planned steps

#### 1. Reproduction (test case)

- **Test:** `test/classifier-hint-regression.test.ts`
  - Send a prompt with `HINT: ...` or `MHINT: ...` through the classifier.
  - Assert: `classifyPrompt()` returns a result with `isHint: true` or suppresses classification and returns a HINT response.
  - Assert: the HINT response is sent to the user as `HINT: ...` (narration or message).

#### 2. Root-cause analysis

- **Code review:**
  - `detectHintDirectly` / `containsHintMarker` — check match logic.
  - `classifyPrompt()` — candidate order, HINT detection, suppression.
  - `extractLastUserPrompt` — are HINT prefixes preserved in the user prompt?
  - `pushRouterInfo` / narration leak — are HINT lines leaking into the prompt?
- **Log analysis:**
  - Search the router log (`~/.pi/logs/router.log`) for HINT lines.
  - Search classification logs for HINT detections.

#### 3. Implement the fix

- **Code change:**
  - Narration leak: `extractLastUserPrompt` must strip router messages (as in 662501a).
  - Match logic: adjust the regex (e.g. `/HINT[:\s]|MHINT[:\s]|MODEL-HINT[:\s]/i`).
  - Ordering: run HINT detection before candidate selection.
- **Regression test:**
  - The step-1 test case must turn green.
  - Existing tests must not break.

#### 4. Finalize the ADR

- If architectural changes become necessary (e.g. pulling HINT detection out of candidate selection), update this ADR.

## Alternatives Rejected

- **Removing the HINT mechanism entirely** — not sensible; it is used in workflows.
- **Workaround via blocklist** — not a clean solution.

## Related Documents

- `src/content-classifier.ts` — HINT detection
- `src/classification-prompt.ts` — prompt preparation
- `src/utils.ts` — `stripRouterNarration` (narration-leak fix 662501a)
- ADR-0002: narration-leak fix (2026-09-18)

## Ownership

Achim / pi-team

## Review

- [ ] Code review via `requesting-code-review` with the code-reviewer template
- [ ] Roborev review before release (AGENTS.md §1)

---
**Created:** 2026-09-27
**Last change:** 2026-09-30 (translated to English per AGENTS.md §3; content unchanged)
**State:** Draft
