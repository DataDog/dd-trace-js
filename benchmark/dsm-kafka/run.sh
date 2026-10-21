#!/usr/bin/env bash
# usage: run.sh <baseline|apm-only|apm+dsm> [optimization-slug]
# Runs the benchmark against the tracer in the worktree that contains this script.
# Env: see README.md (COMMIT_EVERY, WARMUP, COUNT, PROFILE, TIMEIT_OUTPUT, ...).
set -euo pipefail

APP_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$APP_DIR/../.." && pwd)
SCENARIO=${1:-baseline}
SLUG=${2:-base}
SCENARIO_ID=${SCENARIO//+/plus}

[[ -f "$REPO_ROOT/node_modules/.yarn-integrity" ]] || {
  echo "tracer deps missing: run 'yarn install --frozen-lockfile' in $REPO_ROOT" >&2; exit 1; }
[[ -d "$APP_DIR/node_modules/kafkajs" ]] || (cd "$APP_DIR" && npm ci --no-audit --no-fund)

export KAFKA_TOPIC=${KAFKA_TOPIC:-benchmark-topic-node-$SCENARIO_ID-$SLUG}
export TIMEIT_OUTPUT=${TIMEIT_OUTPUT:-$APP_DIR/results.node.$SCENARIO_ID.json}
export PROFILE_OUTPUT=${PROFILE_OUTPUT:-$APP_DIR/profile.node.$SCENARIO_ID.cpuprofile}
export PROFILE=${PROFILE:-0}
export DD_TRACE_STARTUP_LOGS=false
export DD_TRACE_AGENT_URL=${DD_TRACE_AGENT_URL:-http://127.0.0.1:18127}

cd "$APP_DIR"
case $SCENARIO in
  baseline) exec node bench.js ;;
  apm-only) DD_DATA_STREAMS_ENABLED=false exec node --require "$REPO_ROOT/init.js" bench.js ;;
  apm+dsm)  DD_DATA_STREAMS_ENABLED=true  exec node --require "$REPO_ROOT/init.js" bench.js ;;
  *) echo "unknown scenario '$SCENARIO' (baseline|apm-only|apm+dsm)" >&2; exit 2 ;;
esac
