# Repetition Loop Guard Implementation

## Problem

Some models (observed with devstral variants) occasionally get stuck regenerating the same sentence or phrase verbatim, over and over, until they either exhaust max_tokens or fill the context window and the provider rejects further generation. The router's existing soft-failure detection only catches rate-limit and context-overflow text, not self-inflicted repetition loops — the provider is happy to keep streaming, the model is just stuck.

Left unchecked, this burns the full context window and surfaces as a hard context-overflow error, then the router retries the **same unhealthy model** on the next turn and the cycle repeats.

## Solution

A new **repetition guard** detects degenerate token-repetition loops in streamed model output and treats them as a soft failure, so the group falls over to the next candidate instead of letting the loop burn the whole context window.

### Components

1. **`src/repetition-guard.ts`** — Pure detection logic
   - `detectDegenerateRepetition(fullText: string)` → `{ detected: boolean, unit?: string, repeats?: number }`
   - Scans the tail of accumulated text for a short unit repeated consecutively many times
   - Tunable thresholds: minimum total length, minimum unit length, minimum letter count, minimum repeats
   - Only looks backward from the very end — a loop that occurred earlier but was followed by distinct content is ignored (the model recovered)

2. **`index.ts`** — Stream-level integration
   - `consumeWithDetection()` now tracks `repetitionLoop` and `repetitionDetail`
   - Throttled check: only rescans once enough new text has arrived (100 chars)
   - On detection: stops consuming further output, clears timeout, returns `{ ok: false, reason: 'repetition_loop', detail: '"..." xN' }`

3. **`index.ts`** — Soft-failure handling
   - Main candidate loop: `if (result.reason === 'repetition_loop')` → `recordSoftFailure(ref)` + router info message + `continue` to next candidate
   - Force-retry path: same handling, plus a user-facing message
   - Escalation: treated as a soft failure (not rate-limit), so it gets a short soft backoff and model-health demotion, not a hard cooldown or key rotation

### Thresholds

```ts
REPETITION_MIN_TOTAL_LEN = 400;      // Don't check until this much text has accumulated
REPETITION_WINDOW = 3000;            // Only inspect the tail of the accumulated text
REPETITION_MIN_UNIT_LEN = 20;        // Repeating units shorter than this are usually formatting
REPETITION_MAX_UNIT_LEN = 400;       // Upper bound on the repeating unit length
REPETITION_MIN_REPEATS = 6;          // Consecutive identical repeats required
REPETITION_MIN_UNIT_LETTERS = 8;     // Filter out dashes/pipes/whitespace runs
```

### Behavior

- **Detection**: The guard only fires when the **tail** of the accumulated text consists of a short unit repeated consecutively many times — the signature of a degenerate generation loop.
- **Abort**: On detection, the stream is aborted early, avoiding burning the whole context window.
- **Fallback**: The group falls over to the next candidate, same as an empty response.
- **Demotion**: The looping model is demoted via `model-health.ts` so it doesn't immediately rank first again on the next turn.
- **User-facing**: A router info message is emitted: `> [router] mistral/devstral-2512 — wiederholt sich in einer Schleife ("Ich möchte jetzt die Datei bearbeiten und speichern. " x8)`

### False-Positive Avoidance

- **Minimum letter count**: Filters out markdown table separators (`|-----|-----|`) and bullet lists.
- **Tail-only check**: A loop that occurred earlier but was followed by distinct content is ignored — the model recovered.
- **Conservative thresholds**: Requires at least 6 consecutive repeats of a 20+ character unit containing at least 8 letters.

### Testing

- **Unit tests**: `test/repetition-guard.test.ts` — pure function tests covering normal prose, exact loops, table separators, varying lists, and minimum-length gating.
- **Integration test**: `test/repetition-loop-detection.test.ts` — full router pipeline test verifying that a looping model is aborted and the group falls over to a healthy candidate.

## Usage

No configuration required. The guard is active by default for all streams consumed by `driveStream()`.

## Trade-offs

- **Performance**: The detector runs on every ~100 characters of streamed text, but the algorithm is O(n) in the window size and the window is capped at 3000 characters, so the cost is bounded.
- **False positives**: Conservative thresholds minimize false positives on legitimate repeated structures (numbered lists, table formatting).
- **False negatives**: A loop that varies slightly (e.g., "I want to edit the file now. I want to edit the file now.") won't be caught — only exact verbatim repetition is detected.

## Future Work

- **Fuzzy repetition**: Extend detection to catch near-identical repetition with minor variations (e.g., "I want to edit the file now. I want to edit the file now.").
- **Model-specific thresholds**: Allow per-model or per-provider thresholds (e.g., stricter for known-loopy models like devstral).
- **User override**: Add a way for users to disable the guard for a specific model if it's triggering false positives.
