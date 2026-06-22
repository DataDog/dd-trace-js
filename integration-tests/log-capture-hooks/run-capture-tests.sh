#!/bin/bash

# Integration test runner for hook-based log capture
#
# Runs all 7 tests and prints a structured pass/fail summary.
# Manages its own intake server lifecycle — no external setup required.
#
# Usage:
#   From repo root:      ./integration-tests/log-capture-hooks/run-capture-tests.sh
#   From this directory: ./run-capture-tests.sh
#
# Prerequisites:
#   Logger packages must be installed (auto-installed if missing):
#     yarn install

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0
MANAGED_SERVER_PID=""
INTAKE_PORT=19876

# ── Helpers ────────────────────────────────────────────────────────────────────

print_header () { echo ""; echo "=== $* ==="; echo ""; }
print_test   () { printf "  %-52s" "$* ..."; }
pass ()         { echo "PASS"; PASS=$((PASS + 1)); }
fail ()         { echo "FAIL  ← $*"; FAIL=$((FAIL + 1)); }

reset_intake () {
  curl -s -X POST "http://localhost:${INTAKE_PORT}/reset" > /dev/null
}

# Query /stats and assert that exactly $1 records were received.
assert_count () {
  local expected=$1
  local actual
  actual=$(node -e "
    const http = require('http')
    http.get('http://localhost:${INTAKE_PORT}/stats', res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => process.stdout.write(JSON.parse(d).received.toString()))
    }).on('error', () => process.stdout.write('-1'))
  ")
  if [ "$actual" -eq "$expected" ] 2>/dev/null; then
    pass
  else
    fail "expected ${expected} records, got ${actual}"
  fi
}

# Run a test node script, capturing its exit code without triggering set -e.
run_test () {
  local label=$1
  local script=$2
  print_test "$label"
  local exit_code=0
  node "$script" > /dev/null 2>&1 || exit_code=$?
  if [ "$exit_code" -eq 0 ]; then
    pass
  else
    # Re-run to show output, then record failure.
    echo ""
    node "$script" 2>&1 || true
    FAIL=$((FAIL + 1))
  fi
}

# Run a test script that is expected to self-assert (exit 1 on failure).
run_assertion_test () {
  local label=$1
  local script=$2
  print_test "$label"
  local exit_code=0
  node "$script" > /tmp/log-capture-test-out.txt 2>&1 || exit_code=$?
  if [ "$exit_code" -eq 0 ]; then
    pass
  else
    echo ""
    cat /tmp/log-capture-test-out.txt
    FAIL=$((FAIL + 1))
  fi
}

# Kill the managed intake server on exit.
cleanup () {
  if [ -n "$MANAGED_SERVER_PID" ]; then
    kill "$MANAGED_SERVER_PID" 2>/dev/null || true
    wait "$MANAGED_SERVER_PID" 2>/dev/null || true
  fi
  # Fallback: if anything is still holding the port, kill it.
  # Handles cases where SIGTERM didn't fully release the socket in time.
  local stale
  stale=$(lsof -ti :"$INTAKE_PORT" 2>/dev/null) || true
  if [ -n "$stale" ]; then
    kill "$stale" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── Dependencies ───────────────────────────────────────────────────────────────

echo ""
echo "Hook-Based Log Capture — Integration Test Suite"
echo "================================================"
echo ""

printf "Checking logger dependencies ... "
if ! (cd "$SCRIPT_DIR" && node -e "require('winston'); require('bunyan'); require('pino')") 2>/dev/null; then
  echo "installing locally..."
  (cd "$SCRIPT_DIR" && yarn install --silent)
fi
(cd "$SCRIPT_DIR" && node -e "require('winston'); require('bunyan'); require('pino')") 2>/dev/null && echo "ok" || {
  echo "Error: failed to install logger dependencies."
  exit 1
}

# ── Intake server ──────────────────────────────────────────────────────────────

printf "Intake server on :%d ... " "$INTAKE_PORT"
if nc -z localhost "$INTAKE_PORT" 2>/dev/null; then
  echo "already running (using existing)"
  # Reset any stale count from a previous run.
  reset_intake
else
  node "$SCRIPT_DIR/test-intake-server.js" > /dev/null 2>&1 &
  MANAGED_SERVER_PID=$!
  # Wait for the server to be ready.
  for i in $(seq 1 20); do
    nc -z localhost "$INTAKE_PORT" 2>/dev/null && break
    sleep 0.1
  done
  echo "started (pid $MANAGED_SERVER_PID)"
fi

# ── Assertion tests ────────────────────────────────────────────────────────────

print_header "Assertion tests (self-contained, inline servers)"

run_assertion_test "disabled capture — 0 records forwarded" \
  "$SCRIPT_DIR/test-disabled.js"

run_assertion_test "logInjection=false — Pino re-enrichment (3 records + dd context)" \
  "$SCRIPT_DIR/test-log-injection-off.js"

# ── Completeness test ──────────────────────────────────────────────────────────

print_header "Completeness test (stdout-only, no intake)"

print_test "pino apm:pino:log:json completeness check"
output=$(node "$SCRIPT_DIR/test-pino-completeness.js" 2>/dev/null)
if echo "$output" | grep -q "CONFIRMED\|Both channels see the complete record"; then
  pass
else
  echo ""
  echo "$output"
  FAIL=$((FAIL + 1))
fi

# ── Manual capture tests with count assertions ─────────────────────────────────

print_header "Capture tests (intake server on :${INTAKE_PORT})"

reset_intake
print_test "Winston — 5 records with dd context"
node "$SCRIPT_DIR/test-winston-capture.js" > /dev/null 2>&1
assert_count 5

reset_intake
print_test "Bunyan — 5 complete records (pid, hostname, time)"
node "$SCRIPT_DIR/test-bunyan-capture.js" > /dev/null 2>&1
assert_count 5

reset_intake
print_test "Pino wrapAsJson — 5 complete records"
node "$SCRIPT_DIR/test-pino-capture.js" > /dev/null 2>&1
assert_count 5

reset_intake
print_test "Exit flush (beforeExitHandlers, 30s interval) — 3 records"
node "$SCRIPT_DIR/test-exit-flush.js" > /dev/null 2>&1
assert_count 3

# ── Summary ────────────────────────────────────────────────────────────────────

TOTAL=$((PASS + FAIL))
echo ""
echo "================================================"
printf "  Results: %d/%d passed" "$PASS" "$TOTAL"
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ all green"
else
  echo "  ❌ ${FAIL} failed"
fi
echo "================================================"
echo ""

[ "$FAIL" -eq 0 ]
