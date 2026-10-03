# Plan: Repairing the HINT Mechanism (HINT/MHINT/MODEL-HINT prefix)

> **STATUS NOTE (2026-09-30):** this is a historical DRAFT, kept for the
> record — the shipped repair followed ADR-0018 and differs from several
> details below. In particular (verified against `src/content-classifier.ts`):
> `detectHintDirectly(prompt): HintClassificationResult | null` (not
> `boolean`); the shipped regex is
> `/^\s*(HINT|MHINT|MODEL[-_]HINT)\b\s*(?::|(?=\s*(?:use|nutze|verwende|benutz(?:e)?(?:\s+modell)?)\b))\s*:?\s+(.+)/i`
> (colon optional with a group-verb lookahead — not this plan's Option B);
> and per **ADR-0014** the router never emits a plain `HINT:` reply to the
> user — `HINT:` is the USER's reserved channel; the router's own narration
> is `MHINT: …` (acceptance criterion 3 and task 4 below were
> superseded by that channel split). Task checkboxes were never ticked
> because the plan was executed through ADR-0018 instead.

## Goal
The HINT mechanism (HINT/MHINT/MODEL-HINT prefix in the prompt) shall work
again: on HINT detection, classification is suppressed and a HINT reply is
sent to the user.

## Acceptance Criteria
1. HINT prefixes (`HINT:`, `MHINT:`, `MODEL-HINT:`) are recognized in the user prompt.
2. On HINT detection, classification is suppressed and a HINT reply is generated.
3. ~~The HINT reply is sent to the user as `HINT: ...` (narration or message).~~
   *(Superseded by ADR-0014: the router narrates as `MHINT: …`; a bare
   `HINT:` line from the router would collide with the user's reserved
   channel.)*
4. A regression test covers the case.
5. Commit: `fix: repair HINT-mechanism (detect hint prefix and suppress classification)`

---

## Bite-size Tasks (2–5 min)

### 1. Test the reproduction
- [ ] Create new test file `test/classifier-hint-regression.test.ts`.
- [ ] Test case 1: prompt with `HINT: Bitte beachte die folgende Anleitung` (HINT: please follow this guidance) → assert: classification suppressed, HINT reply generated.
- [ ] Test case 2: prompt without HINT → assert: normal classification.
- [ ] Test case 3: test the `MHINT:` and `MODEL-HINT:` prefixes.

**Owner:** pi
**Time:** 15 min

### 2. Analyze the root cause
- [ ] Code review of `src/content-classifier.ts`:
  - `detectHintDirectly(text: string): boolean` — check the regex: `/HINT[:\s]/i`
    *(WRONG even at plan time — the shipped function is
    `detectHintDirectly(prompt): HintClassificationResult | null`, see
    `src/content-classifier.ts`; see the status note above.)*
  - `containsHintMarker(text: string): boolean` — check the logic.
  - `classifyPrompt()` — candidate order, HINT detection, suppression.
- [ ] Check `extractLastUserPrompt`: are router messages stripped? (narration-leak fix 1b69beb)
- [ ] Log analysis: search `~/.pi/logs/router.log` for HINT lines.

**Owner:** pi
**Time:** 20 min

### 3. Implement the fix (code change)
**Option A: narration leak (most likely cause)**
- [ ] Check `extractLastUserPrompt`: if router messages leak in, strip them as in 1b69beb.
- [ ] Check `classifyPrompt`: perform HINT detection BEFORE candidate selection.

**Option B: regex adjustment**
- [ ] Extend the `detectHintDirectly` regex: `/HINT[:\s]|MHINT[:\s]|MODEL-HINT[:\s]/i`

**Option C: suppression logic**
- [ ] Adjust `classifyPrompt` so that on HINT detection the classification is skipped and a HINT reply is returned.

**Owner:** pi
**Time:** 25 min

### 4. Generate the HINT reply
- [ ] On HINT detection: `return { ok: true, isHint: true, hintText: '...' }` or a similar schema.
- [ ] Adjust `stream-orchestrator.ts`: if `isHint: true`, emit the narration `> [router] HINT: ...` and send the reply to the user as a HINT.

**Owner:** pi
**Time:** 15 min

### 5. Finalize the tests
- [ ] `test/classifier-hint-regression.test.ts` must go green.
- [ ] Check the existing tests: `test/classifier-mapping-hints.test.ts`, `test/hint-classification.test.ts` — must not break.
- [ ] If necessary: adjust tests or add new assertions.

**Owner:** pi
**Time:** 10 min

### 6. Verification
- [ ] `npx tsc --noEmit` (clean)
- [ ] `npx vitest run` (existing tests green)
- [ ] `npm run build` → `dist/index.js`
- [ ] Live test: prompt with `HINT: ...` → router emits a HINT reply.

**Owner:** pi
**Time:** 15 min

### 7. Commit & documentation
- [ ] Commit: `fix: repair HINT-mechanism (detect hint prefix and suppress classification)`
- [ ] Commit message body explains WHY (the HINT mechanism was broken; the repair is needed for workflows).
- [ ] CHANGELOG.md entry (optional)
- [ ] Finalize ADR-0018 (if architectural changes turned out to be necessary).

**Owner:** pi
**Time:** 5 min

---

## Total effort
~105 min (cumulative, including tests + verification)

## Dependencies
- None — uses the existing classification logic.

## Risks & mitigations
- **False HINT detection:** test the regex with different prefixes.
- **Narration leak:** strip `extractLastUserPrompt` as in 1b69beb.
- **CI tests break:** adjust existing tests or add new regression tests.

## Review
- Code review via the `requesting-code-review` skill
- Roborev review before release (AGENTS.md §1)

---
**Created:** 2026-09-27
**Last change:** 2026-09-27 (translated to English 2026-09-30 per AGENTS.md §3)
**State:** Draft — superseded by ADR-0018 (the shipped repair); annotated
2026-09-30 to reconcile it with ADR-0014 and the real `detectHintDirectly`
contract.
