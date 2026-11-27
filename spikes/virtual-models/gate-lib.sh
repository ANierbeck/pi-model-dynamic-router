#!/bin/bash
# Shared helpers of the host-upgrade gate scripts (AGENTS §10). Sourced by
# run-retry-matrix.sh and run-router-shape.sh; covered by
# test/spike-gate-lib.test.ts.

# Lines in FILE as an unpadded number (0 when missing). macOS `wc -l` pads
# its count with spaces, so a string comparison against "2" never matched.
count_lines() {
  if [ -f "$1" ]; then awk 'END { print NR }' "$1"; else echo 0; fi
}

# 0 when the observed count GOT (padding allowed) equals WANT.
same_count() {
  local got=${2//[[:space:]]/}
  [[ $got =~ ^[0-9]+$ ]] && [ "$((10#$got))" -eq "$1" ]
}

# The route() reasons logged by retry-probe.ts in FILE, comma-joined in order.
route_reasons() {
  if [ -f "$1" ]; then
    grep -o '"reason":"[a-z]*"' "$1" | sed 's/"reason":"//; s/"$//' | paste -sd, -
  else
    echo
  fi
}

# check_case LABEL WANT_REASONS GOT_REASONS WANT_HUNG GOT_HUNG WANT_EXIT GOT_EXIT WANT_ANSWER GOT_ANSWER
# Compares one retry-matrix case against its baseline; prints one FAIL line
# per deviation and returns 1 when there is any. A case that hangs by
# baseline was killed, so its exit status is not compared. WANT_ANSWER is a
# prefix of the answer; "<empty>" means an empty answer.
check_case() {
  local label=$1 want_r=$2 got_r=$3 want_h=$4 got_h=$5 want_x=$6 got_x=$7 want_a=$8 got_a=$9
  local bad=0
  if [ "$got_r" != "$want_r" ]; then
    echo "  FAIL [$label]: route() reasons $got_r, baseline $want_r"
    bad=1
  fi
  if [ "$got_h" != "$want_h" ]; then
    echo "  FAIL [$label]: hung=$got_h, baseline hung=$want_h"
    bad=1
  fi
  if [ "$want_h" != yes ] && [ "$got_h" != yes ] && [ "$got_x" != "$want_x" ]; then
    echo "  FAIL [$label]: exit status $got_x, baseline $want_x"
    bad=1
  fi
  if [ "$want_a" = "<empty>" ]; then
    if [ -n "$got_a" ]; then
      echo "  FAIL [$label]: answer \"$got_a\", baseline empty"
      bad=1
    fi
  elif [[ $got_a != "$want_a"* ]]; then
    echo "  FAIL [$label]: answer \"$got_a\", baseline starts with \"$want_a\""
    bad=1
  fi
  return $bad
}

# run_bounded SECONDS CMD... — the command's exit status, or 124 when it is
# still running after SECONDS (it is killed then).
run_bounded() {
  local limit=$1
  shift
  "$@" &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$((limit * 10))" ]; then
      kill "$pid" 2>/dev/null
      sleep 0.5
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  wait "$pid"
}

# wait_for_line FILE PATTERN SECONDS — 0 once FILE has a line matching
# PATTERN, 1 when SECONDS pass first.
wait_for_line() {
  local i
  for ((i = 0; i < $3 * 10; i++)); do
    grep -q -- "$2" "$1" 2>/dev/null && return 0
    sleep 0.1
  done
  return 1
}

# resolve_out_dir PREFIX — prints the output directory. An explicit
# $SPIKE_OUT is used as given but must not be a symlink (the scripts
# redirect into it); without one, a fresh private directory is created.
resolve_out_dir() {
  if [ -n "${SPIKE_OUT:-}" ]; then
    if [ -L "$SPIKE_OUT" ]; then
      echo "SPIKE_OUT=$SPIKE_OUT is a symlink; refusing to write into it" >&2
      return 1
    fi
    mkdir -p -- "$SPIKE_OUT" || return 1
    echo "$SPIKE_OUT"
  else
    mktemp -d "${TMPDIR:-/tmp}/$1.XXXXXX"
  fi
}
