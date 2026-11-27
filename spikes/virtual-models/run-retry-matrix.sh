#!/bin/bash
# Replays the retry matrix of docs/research/2026-11-06-virtual-model-spike.md §1
# against the installed pi. Starts the fake provider, runs one `pi -p` per case
# (capped at $CASE_TIMEOUT, default 180 s), prints what route() saw and what
# the user got, and compares every case with the recorded baseline below.
# Output goes to $SPIKE_OUT (default: a fresh private temp directory). Needs
# no credentials.
set -u
here=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=gate-lib.sh
source "$here/gate-lib.sh"
SPIKE_OUT=$(resolve_out_dir vm-spike) || exit 1
export SPIKE_OUT
export SPIKE_PORT=${SPIKE_PORT:-8791}
CASE_TIMEOUT=${CASE_TIMEOUT:-180}
echo "output: $SPIKE_OUT"

node "$here/fake-server.mjs" > "$SPIKE_OUT/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
if ! wait_for_line "$SPIKE_OUT/server.log" "fake provider on" 15; then
  echo "fake provider did not start within 15 s (see $SPIKE_OUT/server.log)" >&2
  exit 1
fi

fails=0

# run LABEL FIRST NEXT  WANT_REASONS WANT_HUNG WANT_EXIT WANT_ANSWER
# The WANT_* columns are the baseline: route() reasons in order, whether pi
# hangs until the case cap, pi's exit status, and the start of the answer.
run() {
  local label=$1 first=$2 next=$3
  rm -f "$SPIKE_OUT/requests.jsonl" "$SPIKE_OUT/routes.jsonl"
  run_bounded "$CASE_TIMEOUT" env SPIKE_FIRST="$first" SPIKE_NEXT="$next" \
    pi -p "say hi" --no-extensions -e "$here/retry-probe.ts" \
    --model spike/auto --no-session --no-tools --no-skills --no-prompt-templates \
    --no-context-files --no-mcp > "$SPIKE_OUT/out.txt" 2>&1
  local status=$? hung=no
  [ "$status" -eq 124 ] && hung=yes
  local answer reasons
  answer=$(tail -1 "$SPIKE_OUT/out.txt" | cut -c1-100)
  reasons=$(route_reasons "$SPIKE_OUT/routes.jsonl")
  echo "### $label"
  echo "  answer: $answer"
  echo "  route() calls: $(count_lines "$SPIKE_OUT/routes.jsonl") ($reasons); exit $status; hung $hung"
  check_case "$label" "$4" "$reasons" "$5" "$hung" "$6" "$status" "$7" "$answer" || fails=$((fails + 1))
  cut -c1-200 "$SPIKE_OUT/routes.jsonl" 2>/dev/null | sed 's/^/    /'
}

# Baseline: docs/research/2026-11-06-virtual-model-spike.md §1, re-recorded on
# Pi 1.6.0 (2026-11-27). A deviation in either direction is a FAIL and fails
# the script: the host-upgrade gate (AGENTS §10) relies on the exit status.
run "plain 429, retry on ok model" spike-a spike-c user,retry no 0 "ok"
run "stream without finish_reason" spike-b spike-c user,retry no 0 "ok"
run "well-formed empty stream" spike-g spike-c user no 0 "<empty>"
run "stall (headers, then silence)" spike-d spike-c user yes - ""
run "always 429 (budget)" spike-a spike-a user,retry,retry,retry no 1 "429: {\"message\":\"rate limit exceeded\""
run "429 'Claude quota exceeded'" spike-e spike-c user no 1 "429: {\"message\":\"Claude quota exceeded"
run "429 'session limit, resets in 3 hours'" spike-h spike-c user,retry no 0 "ok"

echo
if [ "$fails" -gt 0 ]; then
  echo "$fails case(s) deviate from the Pi 1.6.0 baseline"
  exit 1
fi
echo "all cases match the Pi 1.6.0 baseline"
