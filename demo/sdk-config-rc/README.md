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

### Running the app against a real Agent

```bash
DD_SERVICE=sdk-config-demo DD_ENV=demo DD_VERSION=0.0.1 \
DD_REMOTE_CONFIGURATION_ENABLED=true \
DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS=5 \
DD_PROFILING_ENABLED=false \
node demo/sdk-config-rc/app.js
```

The Agent needs `remote_configuration.enabled: true` and the same `DD_SITE`/API key as above.
`service` and `env` must match `service_target` in the payload, or the config will not be
served to this tracer. `curl localhost:8080/state` shows the live config, its origin, whether
the profiler is running, and every `config:update` seen so far.

### Verifying the backend has #14029

`rc-api` has **no version endpoint** — only `/_health`, which returns the literal string `ok`.
The running build is only exposed as the `version` tag on `service:rc-api` (format
`v<build-id>-<short-sha>`), so check that in the org where the target environment reports.

Status as of 2026-09-04: merge commit `c520e14` (merged 15:39Z) is an ancestor of the
`rc-staging` branch but is **not** in any prod datacenter — prod was mid-rollout of a 10:27Z
commit, 211 commits behind it. Since the combined tracer accepts both wire shapes, the demo
works either way; only the object-map form specifically requires #14029.

## Files

| File | Purpose |
| --- | --- |
| `app.js` | Minimal `node:http` app on the combined build; `/state`, `/work` |
| `local-harness.js` | FakeAgent-driven end-to-end demo; asserts the off→on→off transition |
| `preflight.sh` | Validates a payload against real dd-go code |
| `preflight/preflight_test.go` | The Go test `preflight.sh` runs inside dd-go |
| `payloads/profiling-enable.json` | RC config-file form (preflight + FakeAgent) |
| `payloads/jsonapi-profiling-enable.json` | rc-api JSON:API request body (curl) |
| `payloads/rejected-example.json` | Payload the real backend rejects, to prove preflight works |
