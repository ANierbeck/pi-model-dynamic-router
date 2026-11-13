# Live-queue parity: ONNX sidecar vs MLX reference (2026-11-13)

Closes the last measurement step of
`docs/plans/2026-10-31-laya-sidecar-distribution.md` (decision 3: golden set
AND live queue through both backends with identical argmax; the golden run
180/180 was recorded 2026-11-12). Numbers only; the items contain user prompt
text and stay under `~/.laya-ft/data/parity/` (mode 600).

## Setup

- **Items:** all 260 rows of the shadow-evaluation queue
  (`~/.laya-ft/data/shadow-eval/queue.jsonl`), built in the production request
  shape: `prompt` + `context.previousUserMessage`/`context.lastAssistantSnippet`
  where the queue stored them (143 with a previous message, 80 with an
  assistant snippet), then the production truncation
  (`truncatePromptForLaya`) applied — the same input the router sends.
- **MLX reference:** the owner's reference server (`spikes/laya-http/server.py`,
  port 8089, head `5f12495d95d8`), recorded with
  `laya-sidecar/scripts/record-reference.mjs`.
- **ONNX sidecar:** `laya-sidecar/dist/server.js` started from the release
  staging directory `~/.laya-ft/artifacts/r2-1.0.0/release` — the exact
  artifact set the weights release will publish (encoder + head + tokenizer +
  `head.json`), port 8095.
- **Gate:** `laya-sidecar/scripts/parity.mjs --gate 0.99`, the corpus gate.

## Result

**259/260 agree (99.6 %), gate passed.** Max probability delta 0.0057,
confidence drift > 0.05 on 0 items, runtime ~1 m for 260 items.

The single disagreement (`b96982019b439356`) is a near-tie, the same class as
the two corpus disagreements:

| backend | argmax | planning | code_complex | standard |
|---|---|---|---|---|
| MLX | planning | 0.2783 | 0.2738 | 0.1732 |
| ONNX | code_complex | 0.2751 | 0.2760 | 0.1736 |

Both top-2 margins are under 0.005 and the backends' probabilities differ by
less than that — the item is a coin flip between the two backends, not a
conversion defect.

## Reading

With the golden set (180/180) and the corpus sample (298/300) this is the
third parity measurement, and the first on unselected live prompts through
the production request shape. The ONNX artifact that the weights release will
ship reproduces the MLX reference within the known floating-point drift band.
