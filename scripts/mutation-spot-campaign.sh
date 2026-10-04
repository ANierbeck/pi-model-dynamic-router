#!/bin/bash
# scripts/mutation-spot-campaign.sh — periodic vacuity audit of the test suite.
#
# Mutation testing is the gold standard against vacuous tests (tests that
# pass no matter what the code does). This hand-rolled spot campaign breaks
# ONE core invariant at a time and verifies the suite goes red. A mutant
# that survives means a guarded area where no test actually asserts.
#
# Baseline 2026-10-04: 9/9 killed, minimum 2 killers each (isFreeModelRef: 88).
# Registered as the periodic audit in TODO.md; a full StrykerJS campaign is
# the suite-wide successor if the yield justifies it.
#
# SAFETY: every mutation is reverted via `git checkout -- <file>` immediately
# after its suite run. The script ABORTS if the worktree is dirty — never run
# it with uncommitted changes you care about.

set -u
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "❌ ABORT: dirty worktree — commit or stash first."
  exit 1
fi

run_suite() {
  npx vitest run 2>/dev/null | grep -E "Tests " | tail -1
}

mutate() {
  local label="$1" file="$2" orig="$3" mutant="$4"
  python3 - "$file" "$orig" "$mutant" << 'PY'
import sys
f, orig, mutant = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(f).read()
assert s.count(orig) == 1, f"anchor not unique in {f}: {orig[:60]}"
open(f, 'w').write(s.replace(orig, mutant, 1))
PY
  if [ $? -ne 0 ]; then echo "❌ $label: ANCHOR FAILED (skipped)"; return; fi
  local result failed
  result=$(run_suite)
  if echo "$result" | grep -qE "[1-9][0-9]* failed"; then
    echo "💀 $label: KILLED ($result)"
  else
    echo "⚠️  $label: SURVIVED — VACUITY ZONE ($result)"
  fi
  git checkout -q -- "$file"
}

M=src/metrics.ts; R=src/routing.ts; H=src/model-health.ts; S=src/scan-runner.ts; L=src/limit-glue.ts

echo "=== mutation spot campaign $(date +%Y-%m-%d\ %H:%M:%S) ==="

mutate "calculateScore column branch" "$M" \
  "if (column === 'briefcase' || column === 'coding') {" \
  "if (false) {"

mutate "min_gdpval floor" "$R" \
  "return v !== null && v >= g.min_gdpval!;" \
  "return true;"

mutate "best_quality_window" "$R" \
  "const w = this.cfg.best_quality_window ?? 0;" \
  "const w = 0;"

mutate "demoteUnhealthy" "$H" \
  "export function demoteUnhealthy(cache: Cache, refs: string[]): string[] {" \
  "export function demoteUnhealthy(cache: Cache, refs: string[]): string[] { return refs;"

mutate "effCost" "$M" \
  "export function effCost(ref: string): number | 'unknown' {" \
  "export function effCost(ref: string): number | 'unknown' { return 0;"

mutate "extractCapabilityProfiles" "$S" \
  "export function extractCapabilityProfiles(html: string): NonNullable<Cache['capability_profiles']> {" \
  "export function extractCapabilityProfiles(html: string): NonNullable<Cache['capability_profiles']> { return {};"

mutate "recordSoftFailure" "$L" \
  "function recordSoftFailure(ref: string): void {" \
  "function recordSoftFailure(ref: string): void { return;"

mutate "sortBy best scoreOf" "$R" \
  "const scoreOf = (r: string) => calculateScore(r, taskType, this.cfg);" \
  "const scoreOf = (r: string) => 50;"

mutate "isFreeModelRef" "$M" \
  "export function isFreeModelRef(" \
  "export function isFreeModelRef( /*mutation*/ return true;
"

echo "=== done. Worktree must be clean: ==="
git status --porcelain
echo "(empty = clean)"
