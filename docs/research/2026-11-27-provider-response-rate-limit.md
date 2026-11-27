# Rate-limit reset times: what the router reads today, what Pi offers

**Date:** 2026-11-27. Supports
`docs/plans/2026-11-27-provider-response-rate-limit.md`.

## Router log scan

Source: the owner's `~/.pi/logs/router.log` + `router.log.1`, 2026-09-27 to
2026-11-27 (two months). `429 body:` is the line driveStream writes for
every rate-limited candidate; `resets in` is the suffix `formatResetMsg`
appends when a reset time was parsed.

| Provider | `429 body:` lines | with a parsed reset time |
| --- | --- | --- |
| `claude-bridge` (extension provider) | ~200 | almost all (`resets 10:00:00 PM …` text, `parseResetAtMs`) |
| `openrouter` | 217 | **0** |
| `mistral` | 0 | — |
| any other HTTP provider | 0 | — |

OpenRouter body shapes: 137 × `Provider returned error` with an upstream
`metadata.raw` (free Gemma models), 69 × empty body, 10 + 1 × other upstream
free models. None of the texts carries a reset time, so every one of the 217
cooldowns came from the escalating `backoff_minutes` schedule, and the
ADR-0017 bounded wait never triggered for them.

What the log does not show: the response headers. Whether OpenRouter sends
`retry-after` / `X-RateLimit-Reset` on these upstream-pool 429s, and what
Mistral sends on its 429s, is unknown. Step 1 of the plan measures it.

## What Pi 1.6.1 offers

Checked in the repo's `node_modules` (Pi 1.6.1):

- `pi-ai` `dist/types.d.ts:115`: stream option
  `onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>`
  with `ProviderResponse = { status, headers }`. Since 1.6.1 it fires for
  4xx/5xx responses and for each retried attempt on the OpenAI, Azure,
  Anthropic and Google adapters too. Mistral fired it before
  (`dist/api/mistral-conversations.js:189`, called before the `!response.ok`
  check, so 429s are reported).
- `pi-coding-agent` `dist/core/sdk.js:230-238`: Pi's own callback turns this
  into the extension event `after_provider_response` with `status` and
  `headers` only, and drops the `model` argument. `sdk.js:274` and
  `pi-agent-core` `dist/agent.js:313` hand it to the agent loop's stream
  options.
- `pi-ai` `dist/utils/provider-retry.js:30-42`: Pi's in-call retry already
  honours `retry-after-ms` and `retry-after`, but only up to
  `maxRetryDelayMs` (60 s by default). A longer server delay fails the call
  at once, and the router never learns the value. The Mistral adapter does
  not use `retryProviderRequest`, so it makes a single attempt.

## Consequence

The extension event cannot be attributed to a candidate (no provider or
model id; delegation and classifier sub-calls run concurrently). The stream
option can: the router hands it to every physical call it makes in
`tryStream` (`src/stream-proxy.ts:291-306`) and knows the `ref` there.
