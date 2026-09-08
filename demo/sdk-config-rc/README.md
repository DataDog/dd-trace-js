# SDK Configuration + dynamic profiling remote-config demo

Demonstrates a running tracer receiving an `APM_TRACING` / `sdk_config` Remote Configuration
payload and applying it, by turning the profiler on at runtime.

Branch: `demo/sdk-config-profiling-rc` — dd-trace-js PR #9392 (SDK_CONFIGURATION transport)
combined with PR #9626 (profiling via `datadog:config:update`), plus one commit enabling
`DD_PROFILING_ENABLED` in the client allowlist. See the branch's commit messages for the
conflict resolutions and why that third commit is needed.

## One-command demo (no credentials)

```bash
node demo/sdk-config-rc/local-harness.js
```

Expected output, abridged:

```
[harness] sdk_config.config wire shape: object map (post-#14029)
DD_PROFILING_ENABLED=false origin=env_var profilerStarted=false     <- baseline
config:update  DD_PROFILING_ENABLED=true  origin=remote_config
>>> CONFIG CHANGED  DD_PROFILING_ENABLED: false -> true (origin=remote_config)
>>> PROFILER STARTED (was false)
[harness] ack: id=demo-… version=1 apply_state=2                    <- tracer ACKed
[harness] RESULT: PASS
```

Add `--legacy-array-shape` to send the pre-#14029 `[{key,value}]` form instead; the combined
tracer accepts both, so the demo does not depend on #14029 being deployed.

### What this does and does not prove

`local-harness.js` uses the repo's `FakeAgent`, which stubs the Agent's `POST /v0.7/config`.
The payload is authored by the harness, **not** produced by `rc-api`. So:

| Layer | Covered |
| --- | --- |
| 1. `rc-api` (dd-go) — JSON:API validation, allowlist, storage | no — see preflight below |
| 2. RC distribution / TUF targets signing | no |
| 3. Datadog Agent — fetch from backend, serve `/v0.7/config` | stubbed |
| 4. Tracer RC client — polling, products, capability bits, targeting, ack | **yes, real** |
| 5. Tracer config layer — `remote_config.js`, allowlist, `sdk_config` parsing | **yes, real** |
| 6. Application — `config:update` → `profiler.js` → profiler starts | **yes, real** |

## Real backend preflight

Validates a payload against **real dd-go code** rather than an assumption about the wire format.
Copies a Go test into a local dd-go checkout, runs it there so dd-go's module graph applies, and
always removes it (it refuses to run if that tree is already dirty).

```bash
./demo/sdk-config-rc/preflight.sh                                  # accepted payload
./demo/sdk-config-rc/preflight.sh payloads/rejected-example.json   # rejected payload
DD_GO_DIR=/path/to/dd-go ./demo/sdk-config-rc/preflight.sh         # other checkout
```

It exercises `jsonconf.Configuration` / `jsonconf.SDKConfig` (the real request model, including
#14029's object map and the legacy array decoder) and `sdkconfigsecurity.IsAllowed`,
`NormalizeAndValidateCanonical`, `ValidateStored` (the real server-side allowlist).

This is how the demo learned that **`DD_TRACE_ENABLED` is unusable via `sdk_config`**:

```
PASS: IsAllowed("DD_PROFILING_ENABLED") = true
FAIL: IsAllowed("DD_TRACE_ENABLED")     = false  reason=lib_config_owned
FAIL: IsAllowed("DD_API_KEY")           = false  reason=security_risk_excluded
```

`DD_TRACE_ENABLED` is in dd-trace-js's client allowlist but the backend owns it via `lib_config`,
so `DD_PROFILING_ENABLED` is the setting to demo.

## Publishing through the real rc-api

Product: `APM_TRACING`. Payload: `sdk_config.config`, an env-var-keyed string map
(`ddoghq/dd-go#14029`; pre-#14029 it was a `[{key,value}]` array).

Requires an org API key plus an **application key** with `APM_REMOTE_CONFIGURATION_READ` (153)
and `APM_REMOTE_CONFIGURATION_WRITE` (152). `POST /configs` also runs a per-service granular
access check, so the app key's user needs write access to the target service.

Keep keys in the environment — never on the command line or in this repo:

```bash
export DD_SITE=datad0g.com          # Datadog staging
export DD_API_KEY=…                 # not echoed, not committed
export DD_APP_KEY=…
```

Always preflight first:

```bash
./demo/sdk-config-rc/preflight.sh payloads/profiling-enable.json
```

Publish (request body: `payloads/jsonapi-profiling-enable.json`):

```bash
curl -sS -X POST \
  "https://api.${DD_SITE}/api/unstable/remote_config/products/apm_tracing/configs" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  -H 'Content-Type: application/json' \
  -d @demo/sdk-config-rc/payloads/jsonapi-profiling-enable.json
```

Inspect what the backend serves for the target, and the per-tracer apply state (the ack):

```bash
curl -sS -H "DD-API-KEY: ${DD_API_KEY}" -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  "https://api.${DD_SITE}/api/unstable/remote_config/products/apm_tracing/configs/by_target?service=sdk-config-demo&env=demo"

curl -sS -H "DD-API-KEY: ${DD_API_KEY}" -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  "https://api.${DD_SITE}/api/unstable/remote_config/products/apm_tracing/configs/<CONFIG_ID>/status"
```

### Cleanup / revert

The demo is not self-reverting against a real backend. Delete the config when done:

```bash
curl -sS -X DELETE -H "DD-API-KEY: ${DD_API_KEY}" -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  "https://api.${DD_SITE}/api/unstable/remote_config/products/apm_tracing/configs/<CONFIG_ID>"
```

The tracer reverts on its own once the config stops being served: `setRemoteConfig(null)` clears
RC-managed fields, `DD_PROFILING_ENABLED` falls back to its `env_var` origin, and `profiler.js`
stops the profiler. `local-harness.js` asserts exactly that transition.

## End-to-end against a real Agent and real rc-api

This is the full chain: app -> Agent -> RC backend -> `rc-api`, with the config created by curl
instead of through the Datadog UI (the UI calls the same route).

### Which payload shape to send

The **tracer accepts both** shapes, but the **write path does not**. `rc-schema-validation`
validates the request against the embedded `apm-tracing.json`, so:

| Target org's rc-api | Send | Request body |
| --- | --- | --- |
| includes #14029 (**all prod, as of 2026-09-08**) | object map | `payloads/jsonapi-profiling-enable.json` |
| predates #14029 | `[{key, value}]` array | `payloads/jsonapi-profiling-enable-legacy-array.json` |

Sending the object form to a pre-#14029 backend is rejected at schema validation. The legacy
array form is accepted by both, because #14029 kept a read-path decoder for it, so it remains
the safe choice against a backend of unknown version.

### 1. Credentials

```bash
export DD_SITE=datadoghq.com        # or the staging site
export DD_API_KEY=…                 # keep these in the environment only
export DD_APP_KEY=…                 # needs APM remote-config read + write
```

The app key's user also needs write access to the target service, or `POST /configs` returns 403
from the per-service granular access check.

### 2. Agent with remote config enabled

```bash
docker run --rm -d --name dd-agent-rc \
  -e DD_API_KEY="$DD_API_KEY" \
  -e DD_SITE="$DD_SITE" \
  -e DD_REMOTE_CONFIGURATION_ENABLED=true \
  -e DD_APM_ENABLED=true \
  -e DD_APM_NON_LOCAL_TRAFFIC=true \
  -p 8126:8126 \
  gcr.io/datadoghq/agent:7

docker exec dd-agent-rc agent status | grep -iA5 'Remote Configuration'
```

### 3. App, with profiling off at boot

`DD_SERVICE` and `DD_ENV` must match `service_target` in the payload exactly (or the payload must
use `*`), otherwise the tracer discards the config client-side.

```bash
DD_SERVICE=sdk-config-demo DD_ENV=demo DD_VERSION=0.0.1 \
DD_REMOTE_CONFIGURATION_ENABLED=true \
DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS=5 \
DD_PROFILING_ENABLED=false \
node demo/sdk-config-rc/app.js
```

Baseline, from the startup log and `curl -s localhost:8080/state | jq .profiling`:

```
DD_PROFILING_ENABLED=false origin=env_var profilerStarted=false
```

### 4. Preflight, then publish

```bash
./demo/sdk-config-rc/preflight.sh payloads/profiling-enable.json

curl -sS -X POST \
  "https://api.${DD_SITE}/api/unstable/remote_config/products/apm_tracing/configs" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  -H 'Content-Type: application/json' \
  -d @demo/sdk-config-rc/payloads/jsonapi-profiling-enable.json
```

Keep the returned `data.id` as `CONFIG_ID`.

### 5. Expected behavior, and the evidence to capture

Within one poll interval (5s above, plus backend propagation), the app logs:

```
config:update  DD_PROFILING_ENABLED=true  origin=remote_config
>>> CONFIG CHANGED  DD_PROFILING_ENABLED: false -> true (origin=remote_config)
>>> PROFILER STARTED (was false)
```

Three independent confirmations:

```bash
# 1. tracer state: origin is remote_config and the profiler is running
curl -s localhost:8080/state | jq '.profiling, .configUpdates'

# 2. backend agrees the tracer ACKed it (apply_state 2 = acknowledged)
curl -sS -H "DD-API-KEY: ${DD_API_KEY}" -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  "https://api.${DD_SITE}/api/unstable/remote_config/products/apm_tracing/configs/${CONFIG_ID}/status"

# 3. what the backend serves for this target
curl -sS -H "DD-API-KEY: ${DD_API_KEY}" -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  "https://api.${DD_SITE}/api/unstable/remote_config/products/apm_tracing/configs/by_target?service=sdk-config-demo&env=demo"
```

Profiles (the bonus) upload through the Agent's profiling proxy roughly 60s after the profiler
starts; check APM > Profiles for `service:sdk-config-demo env:demo`.

### 6. Cleanup / revert

```bash
curl -sS -X DELETE -H "DD-API-KEY: ${DD_API_KEY}" -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  "https://api.${DD_SITE}/api/unstable/remote_config/products/apm_tracing/configs/${CONFIG_ID}"

docker rm -f dd-agent-rc
```

The tracer reverts on its own once the config stops being served: `setRemoteConfig(null)` clears
RC-managed fields, `DD_PROFILING_ENABLED` falls back to its `env_var` origin, and `profiler.js`
stops the profiler. Expect `>>> PROFILER STOPPED` in the app log.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| No `config:update` at all | Agent RC disabled, or `DD_REMOTE_CONFIGURATION_ENABLED=false` in the app |
| `config:update` fires but value unchanged | `service_target` does not match `DD_SERVICE`/`DD_ENV`. Run with `DD_TRACE_DEBUG=1` and look for `Ignoring config for service:` / `for env:` |
| Value applied but profiler never starts | `DD_PROFILING_ENABLED` missing from `sdkConfigAllowlist` (see commit `0a3a81af0`) |
| 400 at publish | Wrong `sdk_config.config` shape for that backend, or a key the server rejects. Run `preflight.sh` |
| 403 at publish | App key lacks APM remote-config write, or no granular write access to the service |

### Verifying the backend has #14029

`rc-api` has **no version endpoint** — only `/_health`, which returns the literal string `ok`.
The running build is only exposed as the `version` tag on `service:rc-api` (format
`v<build-id>-<short-sha>`), so check that in the org where the target environment reports.

Status as of 2026-09-08: **#14029 is live in every prod datacenter**, for both `rc-api` and
`rc-schema-validation`. Use the object-map payload against prod.

Verified by ancestry, not by inference. Spans for these services carry the full deploy SHA in
`@git.commit.sha`, so the short SHA in the `version` tag does not have to be trusted:

| Service | Live builds (env:prod) | Datacenters |
| --- | --- | --- |
| `rc-api` | `fee0ef2`, `a02b549`, `c0029c4` | us1, us3, us5, eu1, uk1, ap1, ap2 |
| `rc-schema-validation` | `bc1410d`, `a02b549`, `05d7022` | us1, us3, us5, eu1, uk1, ap1, ap2 |

Each was compared against the merge commit with
`gh api repos/ddoghq/dd-go/compare/<deployed>...c520e146…`; all returned `behind` with
`ahead_by: 0`, meaning the deployed build contains it. Reversing the comparison returned
`ahead` with `behind_by: 0`, so the result is not an artifact of base/head ordering. The oldest
live build on either service dates from 2026-09-07, three days after the 2026-09-04 merge.

`rc-schema-validation` matters independently: it `go:embed`s `apm-tracing.json`, so the schema
change only takes effect when that service redeploys. Its oldest live build already postdates
the merge, so the object-map schema is live everywhere rather than only on the newest canary.

No staging deployment of either service was found (zero spans for `env:(staging|stg|sandbox)`),
so prod is the environment to use.

## Files

| File | Purpose |
| --- | --- |
| `app.js` | Minimal `node:http` app on the combined build; `/state`, `/work` |
| `local-harness.js` | FakeAgent-driven end-to-end demo; asserts the off→on→off transition |
| `preflight.sh` | Validates a payload against real dd-go code |
| `preflight/preflight_test.go` | The Go test `preflight.sh` runs inside dd-go |
| `payloads/profiling-enable.json` | RC config-file form, object map (preflight + FakeAgent) |
| `payloads/profiling-enable-legacy-array.json` | Same, pre-#14029 array shape |
| `payloads/jsonapi-profiling-enable.json` | rc-api request body, object map |
| `payloads/jsonapi-profiling-enable-legacy-array.json` | rc-api request body, pre-#14029 array shape |
| `payloads/rejected-example.json` | Payload the real backend rejects, to prove preflight works |
