#!/bin/bash
# Replays the retry matrix of docs/research/2026-11-06-virtual-model-spike.md §1
# against the installed pi. Starts the fake provider, runs one `pi -p` per case
# (180 s cap each), prints what route() saw and what the provider received.
# Output goes to $SPIKE_OUT (default /tmp/vm-spike). Needs no credentials.
set -u
here=$(cd -- "$(dirname -- "$0")" && pwd)
export SPIKE_OUT=${SPIKE_OUT:-/tmp/vm-spike}
export SPIKE_PORT=${SPIKE_PORT:-8791}
mkdir -p "$SPIKE_OUT"
node "$here/fake-server.mjs" > "$SPIKE_OUT/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 1

run() {
  label=$1; first=$2; next=$3
  rm -f "$SPIKE_OUT/requests.jsonl" "$SPIKE_OUT/routes.jsonl"
  SPIKE_FIRST=$first SPIKE_NEXT=$next pi -p "say hi" --no-extensions -e "$here/retry-probe.ts" \
    --model spike/auto --no-session --no-tools --no-skills --no-prompt-templates \
    --no-context-files --no-mcp > "$SPIKE_OUT/out.txt" 2>&1 &
  pid=$!
  for _ in $(seq 1 90); do sleep 2; kill -0 $pid 2>/dev/null || break; done
  if kill -0 $pid 2>/dev/null; then echo "  (still running after 180 s, killed)"; kill $pid; fi
  wait $pid 2>/dev/null
  echo "### $label"
  echo "  answer: $(tail -1 "$SPIKE_OUT/out.txt" | cut -c1-100)"
  echo "  route() calls: $(wc -l < "$SPIKE_OUT/routes.jsonl" 2>/dev/null || echo 0)"
  cut -c1-200 "$SPIKE_OUT/routes.jsonl" 2>/dev/null | sed 's/^/    /'
}

run "plain 429, retry on ok model" spike-a spike-c
run "stream without finish_reason" spike-b spike-c
run "well-formed empty stream" spike-g spike-c
run "stall (headers, then silence)" spike-d spike-c
run "always 429 (budget)" spike-a spike-a
run "429 'Claude quota exceeded'" spike-e spike-c
run "429 'session limit, resets in 3 hours'" spike-h spike-c
