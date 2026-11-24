#!/usr/bin/env bash
# One run in gap mode; per-process JSON lands in <out dir>. Usage: gap.sh <repo dir> <out dir> -- <command...>
set -u
dir=$1 outdir=$2
shift 3
H=$HOME/attribution-spike/e2e
mkdir -p "$outdir"; rm -f "$outdir"/*.json
export PATH=$HOME/attribution-spike/node/node-v24.22.3-linux-x64/bin:$PATH
export DD_CIVISIBILITY_AGENTLESS_ENABLED=1 DD_CIVISIBILITY_AGENTLESS_URL=http://127.0.0.1:5559
export DD_INSTRUMENTATION_TELEMETRY_AGENT_PROXY_ENABLED=0 DD_INSTRUMENTATION_TELEMETRY_URL=http://127.0.0.1:5559
export DD_API_KEY=key DD_ENV=test_env SPIKE_DD_ROOT=$HOME/js/dd-trace-js SPIKE_REPO_ROOT=$dir
export NODE_OPTIONS="-r $HOME/js/dd-trace-js/ci/init -r $H/hook.js" SPIKE_MODE=gap SPIKE_OUT=$outdir
node $HOME/js/bench/mini-intake.js 5559 >/dev/null 2>&1 &
intake=$!
trap 'kill $intake' EXIT
sleep 1
cd "$dir" || exit 1
"$@" 2>&1 | grep -E "^(Tests|Test Suites):"
node -e '
const fs = require("fs"); const d = process.argv[1]; const t = {}; const top = {}
for (const f of fs.readdirSync(d)) { const j = JSON.parse(fs.readFileSync(d + "/" + f))
  for (const [k, v] of Object.entries(j)) if (typeof v === "number" && k !== "pid") t[k] = (t[k] || 0) + v
  for (const [fn, n] of j.top) top[fn] = (top[fn] || 0) + n }
t.processes = fs.readdirSync(d).length
console.log(JSON.stringify(t)); console.log(JSON.stringify(Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 10)))
' "$outdir"
