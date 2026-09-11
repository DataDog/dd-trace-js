# Demo runbook — SDK Configuration remote config end to end

Goal for the audience: **a running tracer receives a Remote Configuration payload and acts on it**,
with the payload validated against real backend code and the result confirmed three independent ways.

Everything is driven by `./demo.sh` so nothing has to be typed live.

## Timing traps — read this first

| Step | Real elapsed time | Consequence for a live demo |
| --- | --- | --- |
| Publish → tracer applies | **~12 s** (observed) | Fine to show live. This is the money shot. |
| Backend ack rollup (`status_count`) | **~1–2 min** | Do not wait in silence. Talk over it, then re-run `./demo.sh confirm`. |
| Delete → tracer reverts | **~5 min** (observed) | **Never wait for this on stage.** See "Showing the revert". |

The offline harness reverts in ~2 s because the fake agent stops serving instantly. Real RC
propagation plus Agent caching is what makes the live revert slow — worth *saying*, since it is a
real property of the system, not a defect.

## Before the talk (~10 min ahead)

```bash
cd <worktree>/demo/sdk-config-rc

~/.dd-rc-demo/check.sh     # credentials present and well-formed; prints no secrets
./demo.sh local            # offline rehearsal, ~30 s, must end RESULT: PASS
./demo.sh setup            # Agent + app; ends by printing the baseline
```

`setup` takes ~60 s (pulls/starts the Agent, waits for `API Key: Authorized`). Leave the app
running. Confirm the baseline reads:

```
DD_PROFILING_ENABLED = 'false'
origin               = 'env_var'
profilerStarted      = False
```

Have two terminals: one for `./demo.sh`, one tailing the app so the audience sees events land live.

```bash
tail -f /tmp/rc-demo-app.log | grep --line-buffered -E 'config:update|CONFIG CHANGED|PROFILER'
```

## The demo

### 1. Baseline — "profiling is off, and off because of the environment"

```bash
./demo.sh confirm      # or just show the setup output still on screen
```

Point at `origin = 'env_var'`. This matters: it proves the later change came from remote config
and not from a restart or a local flag.

### 2. The payload — "and we know the backend accepts it"

```bash
./demo.sh payload
```

Two things to say:

- The payload is `APM_TRACING` with `sdk_config.config`, an env-var-keyed **string map**. That map
  shape is what `dd-go#14029` introduced; before it, this field was a `[{key, value}]` array.
- The validation is not a guess. It runs the payload through the **real** `jsonconf` request model
  and the **real** `sdkconfigsecurity` allowlist from a dd-go checkout.

Then the second half of that command, which is the part people remember:

```
FAIL: IsAllowed("DD_API_KEY")       = false  reason=security_risk_excluded
FAIL: IsAllowed("DD_TRACE_ENABLED") = false  reason=lib_config_owned
```

`DD_TRACE_ENABLED` is in the *tracer's* allowlist but the backend refuses it, because `lib_config`
owns it. That is a real constraint the demo found, and it is why the setting being toggled is
`DD_PROFILING_ENABLED`.

### 3. Publish — "now change it, with the app untouched"

```bash
./demo.sh publish
```

This POSTs to real `rc-api`, then polls until the tracer applies it. Call out:

- **HTTP 201** and the config id.
- The response echoes `config` back as an **object map** — live proof `#14029` is deployed in this
  environment. A pre-`#14029` backend would return an array here.
- In the tail terminal: `config:update` → `CONFIG CHANGED` → `PROFILER STARTED`, ~12 s later.

The app was never restarted, redeployed, or signalled.

### 4. Confirm — three independent sources

`publish` prints these automatically; re-run `./demo.sh confirm` if the ack has not rolled up yet.

1. **The tracer's own view** — `origin` flipped `env_var → remote_config`, `profilerStarted: True`.
2. **The app log** — the `datadog:config:update` publish and the profiler starting, timestamped.
3. **The backend** — `status_count = {"2": 1}`. `2` is `ACKNOWLEDGED`: the *backend* agrees the
   tracer received and applied it. `error_messages` is empty.

Source 3 is the strongest, because it is the backend's word rather than the app's.

### 5. Profiles (optional)

```
https://app.datadoghq.com/profiling/explorer?query=service%3Asdk-config-demo%20env%3Ademo
```

Uploads land every 20 s (`DD_PROFILING_UPLOAD_PERIOD=20`). Give it ~2 min of runtime before
switching to the UI, and set an explicit time range. If profiles have not surfaced, do not stall on
it — the ack in step 4 is the actual claim being demonstrated; profiling is the payload, not the
proof.

## Showing the revert

Do **not** delete on stage and wait. Pick one:

- **Preferred** — show the instant round trip offline: `./demo.sh local` walks off → on → off in
  ~30 s, and explicitly labels which layers are real and which is stubbed.
- **Or** run `./demo.sh revert` ~6 minutes before you need it, and show the already-reverted state
  (`origin` back to `env_var`, `profilerStarted: False`) as a closing beat.

Either way, say plainly that the real revert takes minutes and why.

## After the talk

```bash
./demo.sh revert      # deletes the config from the org
./demo.sh teardown     # stops the app, removes the demo Agent
```

`teardown` warns if a config is still live and prints your remaining containers, so you can see
your own `dd-agent` was untouched. The demo Agent runs under a distinct name and port
(`dd-agent-rc-demo`, 18226) precisely so an existing agent is never disturbed — mine pointed at a
different org, which would have silently broken the demo had it been reused.

Revoke the app key when finished.

## If something breaks live

| Symptom | Do this |
| --- | --- |
| Publish returns 400 | `lib_config` must have `service_name` and `env`. The committed payloads already do; a hand-edited one may not. |
| Publish returns 403 | App key lacks APM remote-config write, or no granular write access to the service. |
| Nothing applies after ~30 s | `DD_SERVICE`/`DD_ENV` must match `service_target` exactly. Restart the app with `DD_TRACE_DEBUG=1` and look for `Ignoring config for service:`. |
| `status_count` stays `{}` | Rollup lag. Re-run `./demo.sh confirm`. The tracer-side evidence already stands. |
| Network or org trouble | Fall back to `./demo.sh local` and say what it stubs. It needs no credentials and no network. |

## Note on config ids

`rc-api` derives the config id from the target, so re-publishing for the same `service`/`env`
returns the **same id** as a previous run. Convenient, but it means "a new id" is not a signal that
anything changed.
