#!/usr/bin/env bash
# Interleaved wall-clock pairs: off (Test Optimization only) vs b (plus a context check at every
# repo function entry and resumption). Usage: e2e.sh <repo dir> <pairs> <out.jsonl> -- <command...>
set -u
dir=$1 pairs=$2 out=$3
shift 4
H=$HOME/attribution-spike/e2e
export PATH=$HOME/attribution-spike/node/node-v24.22.3-linux-x64/bin:$PATH
export DD_CIVISIBILITY_AGENTLESS_ENABLED=1 DD_CIVISIBILITY_AGENTLESS_URL=http://127.0.0.1:5558
export DD_INSTRUMENTATION_TELEMETRY_AGENT_PROXY_ENABLED=0 DD_INSTRUMENTATION_TELEMETRY_URL=http://127.0.0.1:5558
export DD_API_KEY=key DD_ENV=test_env SPIKE_DD_ROOT=$HOME/js/dd-trace-js SPIKE_REPO_ROOT=$dir
export SPIKE_ADDON=$HOME/attribution-spike/c/build/Release/cped.node
node $HOME/js/bench/mini-intake.js 5558 >/dev/null 2>&1 &
intake=$!
trap 'kill $intake' EXIT
sleep 1
cd "$dir" || exit 1
run () {
  local arm=$1 i=$2 log start end code
  shift 2
  log=$(mktemp)
  if [ "$arm" != off ]; then
    export NODE_OPTIONS="-r $HOME/js/dd-trace-js/ci/init -r $H/hook.js" SPIKE_MODE=$arm
  else
    export NODE_OPTIONS="-r $HOME/js/dd-trace-js/ci/init"
  fi
  start=$(date +%s%N)
  "$@" >"$log" 2>&1
  code=$?
  end=$(date +%s%N)
  summary=$(grep -E "^Tests:" "$log" | tail -1)
  echo "{\"arm\":\"$arm\",\"pair\":$i,\"ms\":$(( (end - start) / 1000000 )),\"exit\":$code,\"tests\":\"$summary\",\"load\":\"$(cut -d' ' -f1 /proc/loadavg)\"}" >>"$out"
  rm -f "$log"
}
for i in $(seq 1 "$pairs"); do
  arm=${ARM:-b}
  if [ $((RANDOM % 2)) -eq 0 ]; then run off "$i" "$@"; run $arm "$i" "$@"; else run $arm "$i" "$@"; run off "$i" "$@"; fi
done
