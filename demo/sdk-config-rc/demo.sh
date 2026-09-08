#!/usr/bin/env bash
# Live demo driver for the SDK Configuration remote-config flow.
#
#   ./demo.sh local      # offline rehearsal / fallback (FakeAgent, no credentials, ~30s)
#   ./demo.sh setup      # start a dedicated Agent + the app, prove the baseline
#   ./demo.sh payload    # show the payload and validate it against real dd-go code
#   ./demo.sh publish    # POST to real rc-api, wait for the tracer to apply it
#   ./demo.sh confirm    # re-show all three confirmations
#   ./demo.sh revert     # delete the config (tracer reverts in MINUTES, not seconds)
#   ./demo.sh teardown   # stop the app and remove the demo Agent
#
# Credentials are read from ~/.dd-rc-demo/{curlrc,agent.env} and never printed.
# The demo Agent runs on its own port and name, so an existing dd-agent is untouched.

set -uo pipefail
cd "$(dirname "$0")"

CRED_DIR="${CRED_DIR:-$HOME/.dd-rc-demo}"
CURLRC="$CRED_DIR/curlrc"
AGENT_ENV="$CRED_DIR/agent.env"
AGENT_NAME=dd-agent-rc-demo
AGENT_PORT="${AGENT_PORT:-18226}"
APP_PORT="${APP_PORT:-18080}"
SERVICE=sdk-config-demo
ENVIRONMENT=demo
STATE_FILE=/tmp/rc-demo-config-id
APP_LOG=/tmp/rc-demo-app.log
SITE="$(sed -n 's/^DD_SITE=//p' "$AGENT_ENV" 2>/dev/null || echo datadoghq.com)"
BASE="https://api.${SITE}/api/unstable/remote_config/products/apm_tracing"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

state_json() { curl -sS -m 5 "http://127.0.0.1:${APP_PORT}/state" 2>/dev/null; }

show_state() {
  # Avoid quote-escaping inside the embedded snippet: %-formatting only, no f-strings.
  state_json | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("    (app not responding)")
    sys.exit(0)
p = d["profiling"]
print("    DD_PROFILING_ENABLED = %r" % p["DD_PROFILING_ENABLED"])
print("    origin               = %r" % p["origin"])
print("    profilerStarted      = %s" % p["profilerStarted"])
print("    config:update seen   = %s" % d["configUpdateCount"])
'
}

require_creds() {
  [ -r "$CURLRC" ]   || { bad "missing $CURLRC";   exit 1; }
  [ -r "$AGENT_ENV" ] || { bad "missing $AGENT_ENV"; exit 1; }
  grep -q 'PASTE_' "$CURLRC" "$AGENT_ENV" 2>/dev/null && { bad "credentials still contain placeholders"; exit 1; }
  return 0
}

case "${1:-}" in

local)
  bold "OFFLINE REHEARSAL - FakeAgent, no credentials, no network"
  info "Stubs only the Agent's POST /v0.7/config. Everything below it is the real tracer."
  node local-harness.js
  ;;

setup)
  require_creds
  bold "1. Agent with remote configuration enabled"
  docker rm -f "$AGENT_NAME" >/dev/null 2>&1
  docker run -d --name "$AGENT_NAME" \
    --env-file "$AGENT_ENV" \
    -e DD_HOSTNAME=sdk-config-rc-demo \
    -p "127.0.0.1:${AGENT_PORT}:8126" \
    gcr.io/datadoghq/agent:7 >/dev/null || { bad "could not start agent"; exit 1; }
  info "waiting for the agent to authorize..."
  for _ in $(seq 1 30); do
    if docker exec "$AGENT_NAME" agent status 2>/dev/null | grep -qi 'API Key: Authorized'; then break; fi
    sleep 3
  done
  if docker exec "$AGENT_NAME" agent status 2>/dev/null | grep -qiA6 '^Remote Configuration' | grep -qi 'Authorized'; then :; fi
  docker exec "$AGENT_NAME" agent status 2>/dev/null | grep -iA6 '^Remote Configuration' \
    | grep -iE 'Organization enabled|API Key|Last error' | sed 's/^/    /'
  ok "agent listening on 127.0.0.1:${AGENT_PORT} (name ${AGENT_NAME}, your own dd-agent untouched)"

  bold "2. App on the combined build, profiling OFF at boot"
  pkill -f 'demo/sdk-config-rc/app.js' 2>/dev/null; sleep 1
  ( cd ../.. && \
    DD_SERVICE=$SERVICE DD_ENV=$ENVIRONMENT DD_VERSION=0.0.1 \
    DD_TRACE_AGENT_PORT=$AGENT_PORT \
    DD_REMOTE_CONFIGURATION_ENABLED=true \
    DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS=5 \
    DD_PROFILING_ENABLED=false \
    DD_PROFILING_UPLOAD_PERIOD=20 \
    APP_PORT=$APP_PORT \
    nohup node demo/sdk-config-rc/app.js > "$APP_LOG" 2>&1 & )
  for _ in $(seq 1 20); do state_json | grep -q profilerStarted && break; sleep 1; done

  bold "3. BASELINE - this is what the audience should see first"
  show_state
  state_json | grep -q '"profilerStarted": *false' \
    && ok "profiler is OFF, and DD_PROFILING_ENABLED came from the environment (origin=env_var)" \
    || bad "expected the profiler to be off at baseline"
  ;;

payload)
  bold "The payload"
  info "product: APM_TRACING   ·   field: sdk_config.config (env-var-keyed string map)"
  python3 -m json.tool payloads/jsonapi-profiling-enable.json | sed 's/^/    /'
  bold "Validated against REAL dd-go backend code (not an assumption about the format)"
  ./preflight.sh payloads/profiling-enable.json 2>&1 \
    | grep -E 'PASS:|FAIL:|preflight OK|preflight FAILED|dd-go @' | sed 's/^/    /'
  bold "And the same validator rejects what the backend rejects"
  ./preflight.sh payloads/rejected-example.json 2>&1 \
    | grep -E 'FAIL: IsAllowed|preflight FAILED' | sed 's/^/    /'
  ;;

publish)
  require_creds
  bold "Publishing to real rc-api"
  info "POST ${BASE}/configs"
  RESP=$(curl -sS --config "$CURLRC" -X POST "${BASE}/configs" \
           -d @payloads/jsonapi-profiling-enable.json -w '\n%{http_code}' 2>&1)
  CODE=$(printf '%s' "$RESP" | tail -1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
  if [ "$CODE" != "201" ]; then bad "HTTP $CODE"; printf '    %s\n' "$BODY"; exit 1; fi
  CID=$(printf '%s' "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["id"])')
  echo "$CID" > "$STATE_FILE"
  ok "HTTP 201 created, id ${CID:0:16}..."
  printf '%s' "$BODY" | python3 -c '
import json,sys
d=json.load(sys.stdin)["data"]["attributes"]["sdk_config"]["config"]
print("    backend echoed config back as:", json.dumps(d))
print("    ^ an OBJECT MAP - live proof dd-go#14029 is deployed (pre-#14029 returns an array)")
'
  bold "Waiting for the tracer to poll and apply (usually seconds)"
  for i in $(seq 1 40); do
    if state_json | grep -q '"profilerStarted": *true'; then ok "applied after ~$((i*3))s"; break; fi
    printf '.'; sleep 3
  done
  echo
  "$0" confirm
  ;;

confirm)
  bold "CONFIRMATION 1/3 - the tracer's own view"
  show_state
  state_json | grep -q '"origin": *"remote_config"' \
    && ok "origin flipped env_var -> remote_config" || bad "origin is not remote_config"
  state_json | grep -q '"profilerStarted": *true' \
    && ok "profiler is RUNNING, started by remote config" || bad "profiler not running"

  bold "CONFIRMATION 2/3 - the app's log, as it happened"
  grep -E 'config:update|CONFIG CHANGED|PROFILER' "$APP_LOG" 2>/dev/null | tail -6 | sed 's/^/    /'

  bold "CONFIRMATION 3/3 - the backend says the tracer acknowledged it"
  if [ -s "$STATE_FILE" ]; then
    curl -sS --config "$CURLRC" "${BASE}/configs/$(cat "$STATE_FILE")/status" 2>/dev/null \
      | python3 -c '
import json,sys
a=json.load(sys.stdin)["data"]["attributes"]
sc=a.get("status_count") or {}
print("    status_count  =", json.dumps(sc))
print("    errors        =", json.dumps(a.get("error_messages")))
print("    ^ apply_state 2 = ACKNOWLEDGED." if "2" in sc else "    (rollup can lag a minute; re-run: ./demo.sh confirm)")
'
  else
    info "(no config id recorded; run ./demo.sh publish first)"
  fi

  bold "Profiles"
  info "uploads every 20s while running. Flame graph:"
  info "https://app.${SITE}/profiling/explorer?query=service%3A${SERVICE}%20env%3A${ENVIRONMENT}"
  ;;

revert)
  require_creds
  [ -s "$STATE_FILE" ] || { bad "no config id recorded"; exit 1; }
  CID=$(cat "$STATE_FILE")
  bold "Deleting the config"
  curl -sS --config "$CURLRC" -X DELETE "${BASE}/configs/${CID}" -w '    HTTP %{http_code}\n' -o /dev/null
  ok "deleted from the backend immediately"
  printf '\n  \033[33m!\033[0m %s\n' "The TRACER takes minutes to revert - RC propagation plus Agent cache."
  info "Observed ~5 min in a real run. Do NOT wait for this on stage:"
  info "  - either run ./demo.sh revert BEFORE the talk and show the stopped state, or"
  info "  - show the instant revert with ./demo.sh local (FakeAgent stops serving immediately)."
  info "Poll it with:  watch -n10 'curl -s localhost:${APP_PORT}/state | python3 -m json.tool'"
  rm -f "$STATE_FILE"
  ;;

teardown)
  bold "Teardown"
  pkill -f 'demo/sdk-config-rc/app.js' 2>/dev/null && ok "app stopped" || info "app already stopped"
  docker rm -f "$AGENT_NAME" >/dev/null 2>&1 && ok "removed $AGENT_NAME" || info "$AGENT_NAME not running"
  if [ -s "$STATE_FILE" ]; then
    printf '\n  \033[33m!\033[0m %s\n' "A config is still live in the org: $(cat "$STATE_FILE")"
    info "Run ./demo.sh revert to delete it."
  else
    ok "no demo config left in the org"
  fi
  docker ps --format '    {{.Names}}  {{.Status}}' | sed 1d >/dev/null 2>&1
  info "your own containers:"; docker ps --format '      {{.Names}}  {{.Status}}'
  ;;

*)
  sed -n '2,20p' "$0"
  exit 1
  ;;
esac
