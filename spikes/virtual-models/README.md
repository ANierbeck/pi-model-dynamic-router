# Virtual-model probes

Probes behind `docs/research/2026-11-06-virtual-model-spike.md`. They exist so
the decision of 2026-11-07 — **no migration to Pi virtual models; fix the
turn-state problems in the current design** — can be re-checked against a newer
Pi with the same measurements (plan `docs/plans/2026-11-04-virtual-models-routing.md`,
re-evaluation trigger). Not shipped, not linted, no credentials needed: every
model is served by a local fake provider on `127.0.0.1`.

| file | measures | note § |
|---|---|---|
| `fake-server.mjs` | OpenAI-compatible fake provider; the last character of the model id picks the failure | — |
| `retry-probe.ts` + `run-retry-matrix.sh` | what Pi's retry does per failure class | §1 |
| `state-probe.ts` | `state` for direct requests, fork, resume, independent sessions | §5 (a) |
| `two-layer-probe.ts` | virtual model → group-like extension provider → physical model: attribution, `previous` | §5 (b) |
| `session-id-probe.ts` | session id in `route()` and in a provider's `streamSimple` | §6 |

## Re-run

```sh
spikes/virtual-models/run-retry-matrix.sh        # §1, ~4 min
```

The other probes are run by hand (start `fake-server.mjs` first, `SPIKE_OUT`
must exist); the commands are in the research note.

## Baseline (Pi 1.5.0, 2026-11-06; re-verified 2026-11-07)

| case | `route()` calls | answer |
|---|---|---|
| plain 429 | 2 | retry answers |
| stream without `finish_reason` | 2 | retry answers |
| **well-formed empty stream** | **1** | **empty, no error** |
| **stall** | **1** | **hangs, no timeout** |
| always 429 | 4 (2 s, 4 s, 8 s) | raw error text |
| 429 `Claude quota exceeded` | **1** | turn ends with the error |
| 429 `session limit, resets in 3 hours` | 2 | retry answers |

The migration becomes interesting again when a row in bold changes: Pi detects
stalls, retries a well-formed empty response, or lets an extension decide
whether a provider error is retried (or the retry budget is no longer four
requests). Then re-run `node scripts/virtual-route-shadow.ts --detail=1` on the
current logs.
