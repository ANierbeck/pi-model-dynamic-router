#!/bin/bash
# Host-upgrade gate (AGENTS §10): runs the two-layer router-shape checks
# against the installed Pi. Starts the fake provider itself, so no manual
# setup is needed, and exits nonzero when any check fails.
#   spikes/virtual-models/run-router-shape.sh
set -u
here=$(cd -- "$(dirname -- "$0")" && pwd)
export SPIKE_OUT=${SPIKE_OUT:-/tmp/vm-shape}
export SPIKE_PORT=${SPIKE_PORT:-8791}
mkdir -p "$SPIKE_OUT"
node "$here/fake-server.mjs" > "$SPIKE_OUT/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 1
node "$here/router-shape-run.ts"
