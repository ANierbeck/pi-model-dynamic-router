# Design: Intercepting stopReason 'length' (max_tokens truncation)

## Problem (root cause)
The router classifies every stream like this:
- Content streamed + stream ends cleanly → **always** `ok: true` (blind spot)
- The `done` event's reason (`{ type: "done", reason: "stop" | "length" | "toolUse", message }`) is **never** checked.

Consequence: with `reason: 'length'` (max_tokens reached → answer truncated, task incomplete) the router records a success → no cooldown, no blocklist, no retry → the model gets picked **again** next turn. That is exactly the symptom: "es hört einfach auf, sagt nix mehr" (it just stops, says nothing more) and "wir landen immer wieder im mistral-small-latest" (we keep ending up on mistral-small-latest).

In today's log: 77 stall/empty events, **zero** for mistral/* — because the stream ends cleanly and the router has nothing to complain about.

## Goal
Close the blind spot: recognize `stopReason: 'length'` as a new soft-failure class `truncated_length`, handle it and log it. This fixes the defect for ALL models, not just mistral-small-latest.

## Design decisions

### A) Watcher interception (index.ts)
- **Function**: `consumeWithDetection` gets a new parameter `ref: string` for logging.
- **New variable**: `let truncatedByLength = false;`
- **Event interception**: in the `for await` loop before `proxy.push(event)`:
  ```ts
  if ((event as any).type === 'done') {
    const reason = String((event as any).reason ?? '');
    routerLog(`[stream] ${ref} finished (stopReason: ${reason}, ${accumulatedText.length} chars)`);
    if (reason === 'length') truncatedByLength = true;
  }
  ```
- **Terminal classification**: check before `!hadContent`:
  ```ts
  if (truncatedByLength) {
    return { ok: false, reason: 'truncated_length' };
  }
  ```

### B) stopReason logging (evidence for the residual case)
- Every stream end logs `stopReason` + content length.
- Allows distinguishing:
  - `length`: max_tokens truncation → A catches it.
  - `stop`: the model gives up voluntarily (model-quality problem) → then manual demotion/blocklist.

### C) Orchestrator handling (stream-orchestrator.ts)
- **driveStream loop**: new branch before `isPaidCloudRateLimitFailure`:
  ```ts
  if (result.reason === 'truncated_length') {
    pushError(ref, 'truncated_length (hit max output tokens — answer incomplete)');
    ctx.recordSoftFailure(ref);
    const nextRef = candidates.slice(i + 1).find(r => !ctx.isLimited(r));
    const suffix = nextRef ? `, trying ${nextRef} …` : '';
    pushRouterInfoLogged(
      proxy,
      `> [router] ${ref} — output truncated at max tokens (task incomplete)${suffix}\n\n`
    );
    continue;
  }
  ```
- **bestRef path** (~line 787): extend the branch:
  ```ts
  if (result.reason === 'repetition_loop' || result.reason === 'truncated_length') {
    ctx.recordSoftFailure(bestRef);
    pushRouterInfoLogged(
      proxy,
      `> [router] ${bestRef} — ${result.reason === 'repetition_loop' ? 'stuck in a repetition loop' : 'output truncated at max tokens (task incomplete)'}\n\n`
    );
  }
  ```

### D) Tests
- **Watcher test**: extend the integration test `test/stall-timeout-detection.test.ts` with the case: stream with `done.reason === 'length'` → `ok: false`, `reason: 'truncated_length'`
- **Orchestrator test**: `test/stream-driver-logged.test.ts` or `test/model-health.test.ts` checks narration and soft-failure accumulation.

### E) No changes to detection.ts
- `isRateLimitLikeReason` stays unchanged; `truncated_length` is not a rate-limit-like cause.

## Configuration / migration
- No config change needed.
- `router-config.json` unchanged.
- The existing soft-failure machinery (`recordSoftFailure`, cooldown, blocklist) picks up the new cause automatically.

## Risks & trade-offs
- **False-positive truncation**: a legitimate long output that ends exactly at max_tokens gets retried. Acceptable — max_tokens is high (64k) and truncation is rare.
- **Performance**: one extra `done` check per stream is negligible.
- **Logging**: one extra log line per stream is negligible.

## Acceptance criteria
1. The watcher recognizes `done.reason === 'length'` and returns `{ ok: false, reason: 'truncated_length' }`.
2. The orchestrator starts the next candidate with correct narration.
3. `ctx.recordSoftFailure(ref)` is called.
4. The stopReason is logged (`[stream] ${ref} finished (stopReason: ${reason}, ...)`).
5. Existing tests stay green; new tests cover the case.
6. `npx tsc --noEmit` and `npx vitest run` green.

## Open points (pending evidence)
- If stopReason = `'stop'` (lazy giving-up) → manual demotion/blocklist of mistral-small-latest (ADR-0008 mechanism).

---

## Implementation plan (bite-size tasks)

> **NOTE (2026-09-30):** the checkboxes below were never ticked, but the
> work **was implemented** — see commit `615a6b0` (footer). They are left
> as-is as the historical draft record.

### 1. Design & planning
- [x] Design document created (this file)

### 2. Code changes
- [ ] Extend the `consumeWithDetection` signature: add parameter `ref: string`
- [ ] Adjust the call sites in `tryStream` (2 sites: the `consumeWithDetection` calls)
- [ ] Declare the new variable `truncatedByLength` in the watcher
- [ ] `done` event interception + logging + set the flag in the loop
- [ ] Add the terminal classification for `truncated_length`
- [ ] `stream-orchestrator.ts`: branch for `truncated_length` in the driveStream loop
- [ ] `stream-orchestrator.ts`: extend the branch in the bestRef path

### 3. Tests
- [ ] `test/stall-timeout-detection.test.ts`: add the new `truncated_length` case
- [ ] `test/stream-driver-logged.test.ts` or `test/model-health.test.ts`: check narration and soft failure

### 4. Verification
- [ ] `npx tsc --noEmit` (clean)
- [ ] `npx vitest run` (existing tests green)
- [ ] `npm run build` → `dist/index.js`
- [ ] Live test after a router restart: mistral-small-latest is NOT picked again on truncation; the log shows `[stream] ... finished (stopReason: length, ...)`

### 5. Documentation / commit
- [ ] Commit: `fix: intercept stopReason 'length' as truncated_length soft failure`
- [ ] Commit message body explains WHY (blind spot + symptom)
- [ ] CHANGELOG.md entry (optional)

---
**Created:** 2026-09-27
**Last change:** 2026-09-27 (translated to English 2026-09-30 per AGENTS.md §3)
**State:** Implemented via `615a6b0`
