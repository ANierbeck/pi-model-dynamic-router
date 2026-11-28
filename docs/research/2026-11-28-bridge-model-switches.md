# Model switches in sessions served by `pi-mistral-bridge`

**Date:** 2026-11-28. Supports
`docs/plans/2026-11-28-bridge-rebuilds-on-model-switch.md`. Origin: a
hand-over draft from the bridge's abort diagnosis of 2026-11-27 (not
committed; its two problems are split here and in the plan, AGENTS §11).

## How often the router switches the model

Source: the owner's Pi session files, `~/.pi/agent/sessions/**`, files dated
2026-11-18 to 2026-11-28 (303 files). A "switch" is an assistant message whose
`provider/model` differs from the previous assistant message of the same
session. "At turn start" means the first assistant message after a user
prompt (the router's per-prompt selection); "mid-turn" is any later one
(failover, fallback or tool follow-up inside a turn). The throw-away scan was
not committed.

All sessions:

| | Count |
| --- | --- |
| user turns | 466 |
| model switches at turn start | 51 |
| of them touching a `mistral-bridge/*` model | 8 |

The 19 sessions that used a `mistral-bridge/*` model:

| | Count |
| --- | --- |
| user turns | 178 |
| assistant messages served by the bridge | 1203 |
| switches **into** a bridge model at turn start | 6 |
| switches **into** a bridge model mid-turn | 12 |
| switches **out of** a bridge model at turn start | 7 |
| switches **out of** a bridge model mid-turn | 15 |

Every switch into a bridge model after another model served the session is a
full history rebuild on the bridge side (below). Two thirds of them (12 of 18)
happen inside a turn, not at the router's per-prompt selection. The scan does
not separate failover from fallback or tool follow-up inside a turn.

## When the bridge rebuilds

Checked in the bridge repository @ `84a47ec` (release 0.1.3):

- ADR-0003 (history delta with rebuild fallback): the bridge sends only the
  new user message when the history before it matches the recorded digest;
  the digest includes the model. Rebuild triggers: compaction, `/tree`
  navigation or fork, a changed system prompt or cwd, a model change, a
  crashed `vibe-acp`, a Pi restart, any other digest mismatch, and a session
  marked dirty after a corrective retry (ADR-0010).
- ADR-0007 (process model): one `vibe-acp` process per model, selected by
  `VIBE_ACTIVE_MODEL` at spawn, reused and killed on idle. Switching the model
  inside one ACP session (`session/set_config_option` with `configId:
  "model"`) is rejected because it writes the user's `~/.vibe/config.toml`; a
  non-persisting variant exists in Vibe's app server but not over ACP.
- The bridge's 2026-11-24 ACP surface research: `session/load` is advertised
  (`agentCapabilities.loadSession: true`) but was not exercised; no
  `session/set_model` method exists; `session/resume` is not listed.
- Not stated in the bridge's docs: whether returning to a model (A → B → A)
  reuses process A's older ACP session. The digest mismatch implies a full
  rebuild.

## The draft's second problem: bridge failures are already visible

The draft assumed a dead bridge turn ends like a normal `stop`. That was true
before bridge 0.1.3. Since 0.1.3 (ADR-0010, accepted 2026-11-27) the bridge
ends a second consecutive dead response with
`{ type: 'error', reason: 'error' }` and
`errorMessage = "mistral-bridge: the model wrote tool calls as plain text
again after one corrective prompt; this turn ends as an error."`
(bridge `src/provider.ts:243,977-978`).

The router already handles that shape (`main` @ `ff3d801`):
`consumeWithDetection` (`src/stream-proxy.ts`, error-event branch) checks the
text for abort, rate-limit and overflow wording, and anything else sets
`providerErrorDetected`. That is a soft failure: the error is not forwarded
and driveStream tries the next candidate. Checked with the router's own
detectors on the exact text: `isAbortLikeText` false, `isRateLimitText` false,
`isOverflowErrorText` false. So the router fails over on the first dead turn,
not after the two the draft proposed. It treats the failure as a generic
provider error, with no bridge-specific handling (consistent with AGENTS §9).

Not checked: a live 0.1.3 dead turn passing through the router, and what the
user sees of the text the corrective response had already streamed before
the error.
