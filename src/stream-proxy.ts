/**
 * Streaming helpers, extracted from index.ts as ONE unit (refactor plan
 * 2026-10-02, task 7 — the riskiest move, kept together because the
 * functions form a call cycle: groupStream → tryStream → consumeWithDetection
 * and back into groupStream's fallback path): hostStreamSimple,
 * localStreamLimit, isLocalProvider, tryStream, consumeWithDetection,
 * groupStream. Pure code motion; closure state via live accessors on rt.
 */

import { isAbortLikeText, isRateLimitText, parseResetAtMs, isOverflowErrorText, OVERFLOW_TEXT_SCAN_MAX_CHARS, isOverflowDeltaText, isFreeTierDailyCapText } from './detection.ts';
import { routerLog, debugLogOnce, forgetDebugOnce, debugLog } from './logger.ts';
import { PROVIDER_MAP } from './providers.ts';
import { detectDegenerateRepetition } from './repetition-guard.ts';
import type { SourceModelInfo } from './stream-driver.ts';
import { splitRef } from './utils.ts';
import { type Model, type Context, type SimpleStreamOptions, type AssistantMessageEventStream, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { Config } from './types.ts';
import type { StreamOrchestrator } from './stream-orchestrator.ts';

/**
 * Dependencies createStreamProxy reads from index.ts's extension closure. Exposed as
 * live accessors (getters, plus setters for state the moved code writes), so
 * every read sees the CURRENT closure value — index.ts reassigns cfg/router/
 * managers on reload, and a captured copy would go stale.
 */
interface StreamProxyDeps {
  readonly cfg: Config;
  localStreamsInFlight: number;
  readonly OLLAMA_MAX_CONCURRENT_STREAMS: number;
  readonly registerFreeModelOnDemand: (provider: string, modelId: string) => boolean;
  readonly resolve: (name: string) => { selected: string; candidates: string[]; } | null;
  readonly sessionCtx: any;
  skipReasons: Map<string, string>;
  readonly streamOrchestrator: StreamOrchestrator;
}

export function createStreamProxy(rt: StreamProxyDeps) {
  // ── Streaming helpers (hoisted for early group registration) ─────────

  /**
   * Resolve the host's own streamSimple for a model.
   *
   * pi-ai 0.82.1 removed the module-global API registry — streaming is now owned
   * by the host's ModelRuntime/Provider objects. This is also what makes
   * extension-registered providers (e.g. claude-bridge) visible to the router:
   * calling through the host avoids ever depending on the router's own pi-ai
   * module instance, which could diverge from the host's.
   *
   * Prefers the ModelRuntime (resolves auth, baseUrl and headers exactly like a
   * native pi turn), falls back to the public Provider object.
   */
  function hostStreamSimple(
    model: Model<any>,
    context: Context,
    options: SimpleStreamOptions | undefined
  ): AssistantMessageEventStream | null {
    const registry = rt.sessionCtx?.modelRegistry as any;
    if (!registry) return null;

    const runtime = registry.runtime;
    if (typeof runtime?.streamSimple === 'function') {
      return runtime.streamSimple(model, context, options);
    }

    const provider = registry.getProvider?.(model.provider);
    if (typeof provider?.streamSimple === 'function') {
      return provider.streamSimple(model, context, options);
    }

    // Neither access path resolved — this is the exact interop mismatch this
    // function exists to guard against (host renamed/removed `.runtime` or
    // `.getProvider`). Log distinctly from tryStream's generic "not found"
    // error so it isn't mistaken for an ordinary missing-credentials case.
    routerLog(`[diag] hostStreamSimple: no runtime.streamSimple or getProvider(${model.provider}).streamSimple on modelRegistry — host interface may have changed`);
    return null;
  }

  /**
   * Try streaming from a specific model ref. Returns the stream and a
   * promise that resolves to { ok, hadContent, error? } when the stream
   * finishes or fails.
   */
  // Why a candidate was skipped by tryStream, keyed by ref. driveStream reads
  // this so a silently skipped candidate still shows up in the failure list —
  // otherwise "All 9 candidates failed" lists only 4 and the real reason (model
  // not in Pi's registry, no API key) stays invisible.
  rt.skipReasons = new Map<string, string>();

  // Local-stream concurrency limiter helpers (counter is module-global above;
  // limit + predicate need `cfg`, which is in scope here).
  function localStreamLimit(): number {
    return rt.cfg.ollama_max_concurrent_streams ?? rt.OLLAMA_MAX_CONCURRENT_STREAMS;
  }
  function isLocalProvider(ref: string): boolean {
    return ref.startsWith('ollama/') || ref.startsWith('lm-studio/');
  }

  async function tryStream(
    ref: string,
    context: Context,
    options: SimpleStreamOptions | undefined
  ): Promise<{ stream: AssistantMessageEventStream; ref: string } | null> {
    const skip = (reason: string): null => {
      rt.skipReasons.set(ref, reason);
      debugLogOnce(`tryStream-skip:${ref}`, `[diag] tryStream skipped "${ref}": ${reason}`);
      return null;
    };
    rt.skipReasons.delete(ref);
    if (!rt.sessionCtx) return skip('no session context');
    const { provider, modelId } = splitRef(ref);
    // Skip group virtual models to prevent recursion
    if (rt.cfg.model_groups[provider]) return skip(`"${provider}" is a group, not a provider`);
    let realModel = rt.sessionCtx.modelRegistry.find(provider, modelId);
    if (!realModel) {
      // The ref isn't in Pi's model registry. If it's a configured free
      // model (cfg.providers[provider].free_models), register it on demand —
      // statically-configured free models never go through the scan/
      // cache.available_models path, and since ADR-0021 nothing registers
      // scan-discovered models at session start, so without this on-demand
      // registration tryStream would skip every free model forever (the
      // observed 'claude-sonnet-5 dominates, GLM unused' symptom: free models
      // silently dropped from the cascade).
      if (rt.registerFreeModelOnDemand(provider, modelId)) {
        realModel = rt.sessionCtx.modelRegistry.find(provider, modelId);
      }
      if (!realModel)
        return skip(`not registered in Pi's model registry (provider=${provider}, id=${modelId})`);
    }
    if (rt.cfg.model_groups[realModel.provider])
      return skip(`resolved provider "${realModel.provider}" is a group`);
    // Concurrency guard for LOCAL providers (ollama/lm-studio): each local
    // stream loads a full model into RAM; parallel subagent fan-out can
    // request N models at once and exhaust system RAM → OOM crash. When at
    // the limit, soft-fail this candidate so driveStream falls over to the
    // next one (typically a cloud model). Only applies to local providers;
    // cloud (openrouter, mistral, etc.) is never throttled here.
    //
    // The slot is RESERVED here (before any await) so parallel tryStream
    // callers can't all pass the check in the same microtask and then all
    // increment past the limit. If anything below throws before the stream
    // is handed back, the finally in the reservation wrapper releases it.
    let reservedLocalSlot = false;
    if (isLocalProvider(ref)) {
      if (rt.localStreamsInFlight >= localStreamLimit()) {
        return skip(`local_concurrency_limit (${rt.localStreamsInFlight} of ${localStreamLimit()} local streams in flight)`);
      }
      rt.localStreamsInFlight++;
      reservedLocalSlot = true;
    }
    // Diagnostic: log exactly what the router resolved for this ref, so a failure
    // (or success) can be correlated with the model's actual provider/api/baseUrl
    // fields instead of guessing. Remove once claude-bridge routing is confirmed stable.
    forgetDebugOnce(`tryStream-skip:${ref}`);
    debugLog(`[diag] tryStream resolved "${ref}" -> provider=${realModel.provider} id=${realModel.id} api=${(realModel as any).api} baseUrl=${(realModel as any).baseUrl ?? 'n/a'}`);
    const apiKey = await rt.sessionCtx.modelRegistry
      .getApiKeyForProvider(realModel.provider)
      .catch(() => null);
    const isLocal = (PROVIDER_MAP as any)[realModel.provider]?.local ?? false;
    // Providers the router itself does not manage (not in PROVIDER_MAP — e.g. models
    // registered by other extensions like claude-bridge) are not subject to the
    // router-managed API-key requirement. The model was already found in Pi's own
    // model registry, which means Pi/the extension can stream it on its own (same
    // mechanism the /model command uses). Only enforce apiKey/local for providers
    // the router actually registers itself.
    const routerManaged = Boolean((PROVIDER_MAP as any)[realModel.provider]);
    if (routerManaged && !apiKey && !isLocal) {
      if (reservedLocalSlot && rt.localStreamsInFlight > 0) rt.localStreamsInFlight--;
      return skip(`no API key for provider "${realModel.provider}"`);
    }
    // Strip the group's virtual apiKey from options — it must not reach the real provider
    const { apiKey: _drop, ...baseOpts } = options ?? {};
    const streamOpts = apiKey ? { ...baseOpts, apiKey } : baseOpts;
    // MEDIUM finding (roborev job 302): if hostStreamSimple throws
    // synchronously (instead of returning null), the thrown error would
    // propagate past this point and the reserved local slot would leak —
    // driveStream's candidate-loop catch turns it into a null target and
    // `continue`s before ever reaching the try/finally that releases. Wrap
    // the stream creation so a throw releases the slot and re-throws.
    let stream: AssistantMessageEventStream | null;
    try {
      stream = hostStreamSimple(realModel, context, streamOpts);
    } catch (streamBuildErr) {
      if (reservedLocalSlot && rt.localStreamsInFlight > 0) rt.localStreamsInFlight--;
      throw streamBuildErr;
    }
    if (!stream) {
      // Release the reserved slot — no stream to consume, so driveStream's
      // finally won't run. Without this the slot leaks and local routing
      // deadlocks after enough failures.
      if (reservedLocalSlot && rt.localStreamsInFlight > 0) rt.localStreamsInFlight--;
      throw new Error(
        `No stream handler available for "${ref}" (provider=${realModel.provider}, api=${realModel.api})`
      );
    }
    // Acquire the local concurrency slot AFTER the stream object is built
    // but BEFORE it is handed to the caller for consumption. The matching
    // release happens in driveStream's finally block after consumeWithDetection
    // settles — we can't release here because tryStream doesn't consume the
    // stream, it only opens it. (Slot already reserved above, pre-await.)
    debugLog(`[diag] tryStream streaming "${ref}" via host runtime`);
    return { stream, ref };
  }

  /**
   * Consume an upstream stream, forwarding events to a proxy stream.
   * Detects soft failures: error events, or no content tokens within a
   * timeout window after the stream starts.
   *
   * Returns { ok: true } if the stream completed with content,
   * or { ok: false, reason } if it should be retried on another model.
   */
  async function consumeWithDetection(
    upstream: AssistantMessageEventStream,
    proxy: AssistantMessageEventStream,
    timeoutMs: number,
    stallMs: number,
    ref: string
  ): Promise<{ ok: boolean; reason?: string; detail?: string | undefined; resetAtMs?: number }> {
    let hadContent = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Stall detection: a single timer guards BOTH the first-token window AND
    // mid-stream stalls. The timer is (re)armed on every received event —
    // not just cleared after the first content token — so a stream that opens
    // the connection, emits some content, then goes silent forever (observed
    // with free/rate-limited OpenRouter proxies) is still aborted and handed
    // to the next candidate. Without the re-arm, the for-await loop would
    // block indefinitely: no error, no close, no timeout, no fallback — the
    // whole session hangs until the user hard-kills Pi.
    //
    // Two windows share one timer: `timeoutMs` before the first content token
    // (first-token wait), and `stallMs` after content has started (mid-stream
    // inactivity). They guard different failure modes and needn't be the same
    // duration — a legitimately slow-but-working provider under load can have
    // silent gaps far longer than the first-token wait, so the stall window is
    // a separate, longer configurable value.
    let resolveTimeout: ((v: 'timeout') => void) | null = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      resolveTimeout = resolve;
    });
    const fireTimeout = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      resolveTimeout?.('timeout');
    };
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      const ms = hadContent ? stallMs : timeoutMs;
      timer = setTimeout(fireTimeout, ms);
    };
    const clearTimer = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };
    // Arm the initial first-token timer.
    armTimer();

    // Rate-limit + overflow detection now live in src/detection.ts (single
    // source of truth). Previously isRateLimitText (here, 15 patterns) and
    // isRateLimitError (driveStream, 7 patterns) diverged; both now go through
    // the unified RATE_LIMIT_PATTERNS table imported above.
    //
    // Race: iterate the stream vs timeout
    let rateLimited = false;
    let rateLimitResetAtMs: number | undefined; // Parsed reset time from the error text (if any)
    let rateLimitDetail: string | undefined; // Raw error text for the account-wide free-tier daily cap (see below)
    let overflowDetected = false; // Provider rejected oversized prompt (overflow text)
    let overflowDetail = ''; // Raw provider text that triggered overflow detection
    let repetitionLoop = false; // Model is stuck regenerating the same phrase
    let repetitionDetail = ''; // The repeating unit + count, for the router-info message
    let providerErrorDetected = false; // Any other provider-reported error event (not rate-limit/overflow)
    let providerErrorDetail = ''; // Raw provider error text, for the router-info message
    let userAborted = false; // event.reason === 'aborted' (Ctrl-C or an outer abort signal) — not a model failure
    let accumulatedText = ''; // Accumulate text_delta to check for rate-limit/overflow/repetition text
    let lastRepetitionCheckLen = 0; // Throttle: only re-run the scan once enough new text has arrived
    let truncatedByLength = false; // stopReason 'length' detected (max output tokens hit)
    // Set once the timeout wins the race below. The loop is not cancelled by
    // losing the race — without this flag it kept forwarding the abandoned
    // stream's late events (content, or an 'aborted' terminal once driveStream
    // cancels the candidate) into the proxy, i.e. into the output of the
    // candidate that had already taken over.
    let abandoned = false;
    const iterPromise = (async (): Promise<'done'> => {
      try {
        for await (const event of upstream) {
          if (abandoned) return 'done';
          // Re-arm the stall timer on every event — this both cancels the
          // first-token timeout once content starts AND restarts the
          // inactivity window for the rest of the stream. A stream that emits
          // content then goes silent will trip the timer again.
          if (!hadContent) {
            const t = event.type;
            if (
              t === 'text_delta' ||
              t === 'thinking_delta' ||
              t === 'toolcall_start' ||
              t === 'toolcall_delta'
            ) {
              hadContent = true;
            }
          }
          armTimer();
          if (event.type === 'error') {
            clearTimer();
            // pi-ai's AssistantMessageEvent contract (types.d.ts) has a stream
            // terminate with `{type:'error', reason:'aborted'|'error', error}`
            // for BOTH a genuine provider fault AND a user/agent-initiated
            // cancellation (e.g. Ctrl-C mid-generation, or an outer abort
            // signal from the caller) — the underlying provider's stream()
            // catches the abort and sets `stopReason: signal?.aborted ?
            // "aborted" : "error"` itself. Without this check, a plain user
            // cancellation on a paid cloud model would fall through to the
            // providerErrorDetected branch below and get escalated to a hard
            // cooldown + key rotation ("likely rate limit") even though
            // nothing was wrong with the provider (roborev job 345 HIGH).
            if ((event as any).reason === 'aborted') {
              userAborted = true;
              // Forward the real event so the caller sees a proper
              // stopReason:'aborted' message — pi-ai's own retry/abort
              // handling already treats this specially (never retried, no
              // cooldown recorded against the model).
              proxy.push(event);
              return 'done';
            }
            // Check if this is a rate limit or subscription error from claude-bridge.
            // pi-ai's openai-completions provider puts the message on
            // `.errorMessage` (the assistant-message shape), not `.message` —
            // check both so this works across provider families.
            const errObj = (event as any).error;
            const errorMsg = String(errObj?.errorMessage || errObj?.message || errObj || '');
            // A provider/transport can also report a client-side or
            // cascade-induced abort as free-text inside an `error` event
            // whose `.reason` is NOT 'aborted' (observed from claude-bridge,
            // which serializes its own AbortError into errorMessage as "This
            // operation was aborted" without setting the structured reason
            // field). Without this check the text falls through to the
            // providerErrorDetected branch below and gets classified as
            // reason:'provider_error', which isPaidCloudRateLimitFailure
            // treated as rate-limit-shaped at the time (it is text-gated
            // since 2026-09-27, but abort text must still never be counted
            // as a provider failure at all) — back then this applied a
            // 2-hour hard cooldown to
            // a model that was never actually rate-limited, just caught in
            // the blast radius of an unrelated crash (F10, 2026-09-02 review:
            // a subagent fanout crashed Ollama, the cascade aborted an
            // in-flight pi-claude/claude-sonnet-5 call, and the router locked
            // Sonnet out of tactical/strategic for 2 hours).
            if (isAbortLikeText(errorMsg)) {
              userAborted = true;
              // Unlike the structured reason:'aborted' case above, this event
              // does NOT already carry the 'aborted' signal (that's the whole
              // point — the provider/transport reported it as free text
              // instead). Normalize it before forwarding so downstream
              // consumers (pi-ai's own retry/abort handling) see the same
              // shape they'd get from a structured abort, instead of a raw
              // error event they might not recognize as a cancellation.
              proxy.push({
                ...(event as any),
                reason: 'aborted',
                error: { ...(errObj as any), stopReason: 'aborted' },
              } as any);
              return 'done';
            }
            if (isRateLimitText(errorMsg)) {
              rateLimited = true;
              // Try to extract the reset time from the error text. This lets
              // the router set a cooldown that exactly matches the provider's
              // window (e.g. 2.5h for a five_hour rate limit), instead of
              // guessing with the escalating backoff schedule and risk
              // re-picking the model before the window actually resets.
              rateLimitResetAtMs = parseResetAtMs(errorMsg);
              // OpenRouter's free-models-per-day cap is ACCOUNT-WIDE (one
              // 429 covers every openrouter/*:free model) and resets at
              // 00:00 UTC. driveStream needs the text to cool down ALL
              // :free candidates at once — without this, only the failing
              // ref got the ordinary 60s backoff (live finding 2026-10-03:
              // 14 of a session's 23 errors were re-burned cap attempts).
              if (isFreeTierDailyCapText(errorMsg)) rateLimitDetail = errorMsg;
            }
            // Check if this is a context-overflow rejection (Mistral/OpenAI/etc.)
            if (isOverflowErrorText(errorMsg)) {
              overflowDetected = true;
              overflowDetail = errorMsg;
            }
            // Any other provider-reported error — e.g. pi-ai's "Provider
            // finish_reason: <reason>" when a free OpenRouter model (minimax,
            // north-mini-code, inkling observed in practice) ends its stream
            // with an unrecognized finish_reason like a raw "error" value.
            // This still counts as a failure even when content streamed
            // first (hadContent already true) — without this branch it fell
            // through every check below to the final `return { ok: true }`,
            // silently treating a mid-stream provider error as a successful
            // completion: no cooldown recorded, the same broken model gets
            // picked again next turn, and the failure repeats as an apparent
            // hang/loop.
            if (!rateLimited && !overflowDetected) {
              providerErrorDetected = true;
              providerErrorDetail = errorMsg;
            }
            // Don't forward error events — treat as soft failure so driveStream
            // can try the next candidate without showing an error to the user.
            return 'done';
          }
          // NO rate-limit scan on text_delta. The model's own prose is never
          // evidence of a rate limit: the pattern table matches everyday words
          // ('out of', 'exceeded', 'quota', 'credits', 'rate limit'), so any
          // answer that merely talked about limits was killed mid-sentence,
          // discarded and restarted on the next candidate (2026-09-27
          // afternoon: 25 mid-stream kills of paid/subscription models while
          // debugging the router's own limit handling). The scan was also
          // useless for its stated purpose: pi-claude-bridge reports a real
          // Claude limit as an `error` EVENT (errorMessage "Claude rate limit
          // ..."), handled above, and its yellow warning is a piUI.notify UI
          // notification that never enters this stream.
          if (event.type === 'text_delta') {
            const delta = String((event as any).delta || (event as any).text || '');
            accumulatedText += delta;
            // Some providers return overflow rejections as text content rather
            // than as an error event. Detect it so driveStream can emit the
            // native overflow error and trigger Pi compaction instead of hanging.
            // Only at the very start of the answer: such a rejection IS the
            // whole (short) response, whereas a real answer discussing context
            // windows or compaction — this router's own domain — can contain
            // the same phrases much later and must not be killed for it.
            if (accumulatedText.length <= OVERFLOW_TEXT_SCAN_MAX_CHARS && isOverflowDeltaText(accumulatedText)) {
              overflowDetected = true;
              overflowDetail = accumulatedText;
              clearTimer();
              // Stop consuming — don't forward the raw provider error text
              return 'done';
            }
            // Some models (observed with devstral variants) get stuck
            // regenerating the same sentence/phrase verbatim instead of
            // finishing the turn. Left alone this burns the whole context
            // window and surfaces as a hard overflow error, after which the
            // router would just retry the same unhealthy model again. Catch
            // it early as a soft failure instead so the group falls over to
            // the next candidate. Throttled — only rescan once enough new
            // text has arrived, so a long healthy stream isn't rescanned on
            // every single delta.
            if (accumulatedText.length - lastRepetitionCheckLen >= 100) {
              lastRepetitionCheckLen = accumulatedText.length;
              const rep = detectDegenerateRepetition(accumulatedText);
              if (rep.detected) {
                repetitionLoop = true;
                repetitionDetail = `"${(rep.unit ?? '').trim().slice(0, 80)}" x${rep.repeats}`;
                clearTimer();
                // Stop consuming — don't forward more of the repeated text
                return 'done';
              }
            }
          }
          // Intercept the terminal done event to capture the stopReason.
          // pi-ai's stream protocol: done carries reason 'stop' | 'length' |
          // 'toolUse' on the final AssistantMessage. 'length' means max output
          // tokens were hit — the answer is truncated and the task incomplete.
          // Pre-fix this was never inspected: a content-streaming stream that
          // ended cleanly was ALWAYS { ok: true }, so a truncating model
          // (mistral/mistral-small-latest, 2026-09-27: "it just stops, never
          // finishes the task") recorded success and was picked again next
          // turn. Now 'length' is a soft failure so driveStream falls over to
          // the next candidate. The done event is NOT forwarded in that case:
          // forwarding it would terminate the proxy stream and silently drop
          // every later event of the cascade (same pattern as the rate-limit /
          // overflow / repetition early returns above).
          if ((event as any).type === 'done') {
            const doneReason = String((event as any).reason ?? '');
            routerLog(`[stream] ${ref} finished (stopReason: ${doneReason}, ${accumulatedText.length} chars)`);
            if (doneReason === 'length') {
              truncatedByLength = true;
              clearTimer();
              // Stop consuming — don't forward the terminal done event
              return 'done';
            }
            // Empty response (stopReason 'stop', zero content — the
            // claude-bridge empty-turn signature, live finding 2026-10-03):
            // do NOT forward the terminal done. Forwarding terminates the
            // proxy and silently drops every later cascade event — the
            // failure narration AND the next candidates' content — so the
            // user sees a bare empty message and recovery depends on pi's
            // outer retry instead of the router's own cascade (same trap as
            // the length case above; rate-limit/overflow/repetition already
            // return early for the same reason).
            if (!hadContent) {
              clearTimer();
              return 'done';
            }
          }
          proxy.push(event);
        }
      } catch (err) {
        clearTimer();
        // Stream threw — treat as soft failure
        return 'done';
      }
      clearTimer();
      return 'done';
    })();

    const winner = await Promise.race([iterPromise, timeoutPromise]);

    if (winner === 'timeout') {
      abandoned = true;
      // Timeout fired. Two cases share one timer:
      //  - empty_timeout: no content ever arrived (first-token window expired)
      //  - stall_timeout: content started, then the stream went silent for
      //    the full window (mid-stream stall). Both are soft failures that
      //    hand off to the next candidate; stall_timeout just tells the user
      //    a more accurate reason ("stream stalled" vs "no response").
      return { ok: false, reason: hadContent ? 'stall_timeout' : 'empty_timeout' };
    }

    // Stream completed — check if we actually got content or hit a rate limit
    if (userAborted) {
      // User/agent-initiated cancellation, not a model failure — checked
      // before every other classification (highest priority) so an abort
      // can never be misread as a rate-limit/overflow/provider_error and
      // escalated into a cooldown. The real aborted event was already
      // forwarded to the caller above; driveStream must stop the whole
      // cascade here rather than trying the next candidate or recording
      // any failure against this one.
      return { ok: false, reason: 'aborted' };
    }
    if (overflowDetected) {
      // Provider rejected the prompt as too large for its context window.
      // This is the runtime counterpart to the pre-flight context-window guard
      // (which relies on a token estimate that can undercount when messages
      // carry tool-result content blocks). Surface it so driveStream can emit
      // the native overflow error and let Pi run compaction, instead of trying
      // every remaining candidate (they share the same oversized prompt).
      return { ok: false, reason: 'context_overflow', detail: overflowDetail || undefined };
    }
    if (rateLimited) {
      // Rate limit or subscription error — soft failure, try next model.
      // Pass through the parsed reset time so recordLimit can set a cooldown
      // that exactly matches the provider's window (instead of the default
      // escalating backoff that might expire too early for long windows).
      // Strip the key when undefined so exactOptionalPropertyTypes is happy.
      return {
        ok: false,
        reason: 'rate_limit_exceeded',
        ...(rateLimitResetAtMs ? { resetAtMs: rateLimitResetAtMs } : {}),
        ...(rateLimitDetail ? { detail: rateLimitDetail } : {}),
      };
    }
    if (repetitionLoop) {
      // Model is stuck regenerating the same phrase — soft failure, try next
      // model instead of letting it burn the whole context window.
      return { ok: false, reason: 'repetition_loop', detail: repetitionDetail || undefined };
    }
    if (providerErrorDetected) {
      // Any other provider error event (not rate-limit/overflow) — soft
      // failure, try next candidate. Checked before `!hadContent` on purpose:
      // a provider that streams partial content and THEN errors still needs
      // this branch, since hadContent alone would otherwise report success.
      return { ok: false, reason: 'provider_error', detail: providerErrorDetail || undefined };
    }

    if (truncatedByLength) {
      // stopReason 'length' means max output tokens hit — answer truncated, task incomplete.
      return { ok: false, reason: 'truncated_length' };
    }

    if (!hadContent) {
      return { ok: false, reason: 'empty_response' };
    }

    return { ok: true };
  }

  // Rate-limit error detection for fallback logic.
  // Only treat REAL rate-limit errors as triggering fallback.
  // Rate-limit detection now uses the unified isRateLimitText from
  // src/detection.ts. Previously this was a SECOND, divergent scanner
  // (7 patterns) that disagreed with consumeWithDetection's scanner (15
  // patterns). Both paths now share one pattern table — no more divergence.
  //
  // empty_response/empty_timeout are NOT rate limits because they can
  // be transient overloads (especially for free models) — triggering a
  // fallback cascade on every empty response would exhaust all tiers
  // when a simple retry would suffice.
  function groupStream(
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream {
    const useStaticMatch = model.id.match(/^(.+):use-static$/);
    const useStatic = useStaticMatch !== null;
    const groupName = useStaticMatch ? useStaticMatch[1] : model.id;
    const g = rt.cfg.model_groups[groupName];
    const isDynamic = g?.method === 'dynamic';
    // Stamped onto every synthetic error AssistantMessage this call produces —
    // must exactly match `model` (Pi's `agent.state.model`), including the
    // `:use-static` suffix on `.id` when present, or Pi's overflow-recovery
    // sameModel check silently fails and auto-compaction never fires.
    const sourceModel: SourceModelInfo = { provider: model.provider, id: model.id, api: model.api };

    if (!isDynamic) {
      const res = rt.resolve(groupName);
      if (!res) throw new Error(`No available models for group "${groupName}"`);
      // fall through with res below
      const proxy = createAssistantMessageEventStream();
      const candidates = [...res.candidates];
      // Cost tracking moved to turn_end (2026-09-27, review I2): the old
      // selection-time call passed hardcoded 1000/500 tokens — fabricated
      // audit data. Only completed turns with REAL provider-reported usage
      // are tracked now.
      rt.streamOrchestrator.driveStream(proxy, candidates, context, options, undefined, groupName, undefined, sourceModel);
      return proxy;
    }

    return rt.streamOrchestrator.groupStream(model, context, options);
  }

  return { groupStream, tryStream, consumeWithDetection, isLocalProvider, localStreamLimit };
}
