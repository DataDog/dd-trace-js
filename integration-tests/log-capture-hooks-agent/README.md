# log-capture-hooks-agent — integration test app

End-to-end integration test for the **hook-based log capture** feature in dd-trace.

The feature works by subscribing to diagnostic channels published by the logger
instrumentations (pino, winston, bunyan). Each log record is serialised to JSON
and forwarded to a configurable HTTP endpoint — without the user having to
configure a custom transport.

## Directory contents

| File | Purpose |
|---|---|
| `app.js` | Express app that logs via pino (v5.14+), winston, and bunyan |
| `app-pino-legacy.js` | Pino-only app for testing pino < 5.14.0 (old `asJson` capture path) |
| `mock-intake.js` | Minimal NDJSON HTTP server that collects forwarded log records |
| `start-dev.js` | Convenience script — starts both servers and prints records inline |
| `index.spec.js` | Mocha integration tests for pino v5.14+, winston, and bunyan |
| `index-pino-legacy.spec.js` | Mocha integration tests for pino < 5.14.0 |
| `package.json` | Local npm dependencies for manual testing |

---

## Usage 1 — automated integration tests (mock-driven)

There are two spec files, each targeting a different pino version range:

| Spec file | Pino version | Capture code path |
|---|---|---|
| `index.spec.js` | `^9` (latest) | `wrapAsJson` wrapping `asJsonSym` → `apm:pino:log:json` |
| `index-pino-legacy.spec.js` | `>=5 <5.14.0` | `wrapAsJson` wrapping `asJsonSym` → `apm:pino:log:json` |

Both specs use the `useSandbox` helper which installs the specified package
versions into a temporary directory, yarn-links `dd-trace` from the repo root,
spawns the app with all required `DD_*` environment variables, and drives HTTP
requests to assert records appear in the mock intake.

### Run the tests

Mocha is installed at the repo root, so all commands run from there:

```bash
# Navigate to the repo root first
cd /path/to/dd-trace-js

# pino v9 + winston + bunyan
./node_modules/.bin/mocha --timeout 60000 \
  integration-tests/log-capture-hooks-agent/index.spec.js

# pino < 5.14.0 (old wrapAsJson capture path)
./node_modules/.bin/mocha --timeout 60000 \
  integration-tests/log-capture-hooks-agent/index-pino-legacy.spec.js
```

Or use the mocha wrapper (recommended when the spec file is the entry point):

```bash
node scripts/mocha-run-file.js \
  integration-tests/log-capture-hooks-agent/index.spec.js

node scripts/mocha-run-file.js \
  integration-tests/log-capture-hooks-agent/index-pino-legacy.spec.js
```

### What the tests verify

**`index.spec.js`** — pino v9, winston, bunyan:

| Logger  | Message field | Level encoding                         | Test routes                    |
|---------|---------------|----------------------------------------|--------------------------------|
| pino    | `msg`         | numeric (30/40/50)                     | `GET /info`, `/warn`, `/error` |
| winston | `message`     | string (`"info"`, `"warn"`, `"error"`) | `GET /winston/info`, …         |
| bunyan  | `msg`         | numeric (30/40/50)                     | `GET /bunyan/info`, …          |

**`index-pino-legacy.spec.js`** — pino `>=5 <5.14.0`:

| Logger | Message field | Level encoding     | Test routes                    |
|--------|---------------|--------------------|--------------------------------|
| pino   | `msg`         | numeric (30/40/50) | `GET /info`, `/warn`, `/error` |

### Why two pino spec files?

Pino `5.14.0` introduced the `mixin` API. Both code paths use the same `wrapAsJson`
hook (wrapping `asJsonSym`) and publish the complete serialised JSON on the
`apm:pino:log:json` diagnostic channel, so the spec behaviour is identical.

The legacy spec exists to confirm the older `asJson` symbol path (pre-mixin) still
forwards records correctly end-to-end.

---

## Usage 2 — manual testing with curl

`start-dev.js` starts both the mock-intake server and the app in a single
command. Forwarded log records are printed inline in the same terminal as
they arrive, so there is no need to watch a separate process.

### Prerequisites

Install the local dependencies once (from this directory):

```bash
cd integration-tests/log-capture-hooks-agent
yarn install
```

### Start both servers

```bash
# From the repo root:
cd /path/to/dd-trace-js

# Default — app.js (pino v9 + winston + bunyan)
node integration-tests/log-capture-hooks-agent/start-dev.js

# Legacy pino — app-pino-legacy.js (pino < 5.14.0, wrapAsJson path)
node integration-tests/log-capture-hooks-agent/start-dev.js --legacy
```

The `--legacy` flag automatically installs `pino@>=5 <5.14.0` (with `--no-save`) if
the wrong version is found in `node_modules`, so no manual prerequisite step is needed.
To restore pino to the version in `package.json` afterward:

```bash
cd integration-tests/log-capture-hooks-agent && yarn install
```

Optional environment overrides (both modes):

```bash
INTAKE_PORT=8888 APP_PORT=3000 \
  node integration-tests/log-capture-hooks-agent/start-dev.js [--legacy]
```

### Example session — default mode

```
Mock intake listening on http://127.0.0.1:7777
App      → http://127.0.0.1:54321  [app.js]

Example curl commands:

  # pino (numeric levels: 30=info, 40=warn, 50=error)
  curl http://127.0.0.1:54321/info
  ...
  # winston (string levels)
  curl http://127.0.0.1:54321/winston/info
  ...
  # bunyan (numeric levels: 30=info, 40=warn, 50=error)
  curl http://127.0.0.1:54321/bunyan/info
  ...

Forwarded log records will be printed here as they arrive.
Press Ctrl+C to stop.

# After running: curl http://127.0.0.1:54321/winston/info

--- log record received ---
{
  "level": "info",
  "message": "winston info route hit",
  "route": "/winston/info",
  "dd": { "trace_id": "...", "span_id": "...", "service": "log-capture-dev", "env": "dev" }
}
---------------------------
```

### Example session — legacy pino mode (`--legacy`)

```
pino v9.6.0 — installing pino@>=5 <5.14.0 (--no-save)...
...npm output...
Done. Run `yarn install` in this directory to restore pino when finished.

Mock intake listening on http://127.0.0.1:7777
Mode: pino legacy (< 5.14.0) — wrapAsJson capture path
App      → http://127.0.0.1:54321  [app-pino-legacy.js]

Example curl commands:

  # pino (numeric levels: 30=info, 40=warn, 50=error)
  curl http://127.0.0.1:54321/info
  curl http://127.0.0.1:54321/warn
  curl http://127.0.0.1:54321/error

Forwarded log records will be printed here as they arrive.
Press Ctrl+C to stop.

# After running: curl http://127.0.0.1:54321/info

--- log record received ---
{
  "pid": 12345,
  "hostname": "...",
  "level": 30,
  "time": 1700000000000,
  "msg": "pino info route hit",
  "route": "/info",
  "dd": { "trace_id": "...", "span_id": "...", "service": "log-capture-dev", "env": "dev" }
}
---------------------------
```

Each curl request causes the app to emit a log. The record is captured by
dd-trace's log capture channel, buffered in the sender, and flushed to the
mock-intake within `DD_LOG_CAPTURE_FLUSH_INTERVAL_MS` milliseconds (200 ms in
dev mode). The record then appears inline in the terminal.

### Running the app standalone (no dev script)

You can also start the two servers separately in different terminals:

**Terminal 1 — mock-intake:**
```bash
node integration-tests/log-capture-hooks-agent/mock-intake.js
# Prints: mock-intake listening on http://127.0.0.1:7777
```

**Terminal 2 — app:**
```bash
DD_TRACE_ENABLED=true \
DD_LOG_CAPTURE_ENABLED=true \
DD_LOG_CAPTURE_HOST=127.0.0.1 \
DD_LOG_CAPTURE_PORT=7777 \
DD_LOG_CAPTURE_FLUSH_INTERVAL_MS=200 \
DD_LOGS_INJECTION=true \
DD_SERVICE=my-service \
DD_ENV=dev \
DD_TRACE_STARTUP_LOGS=false \
  node integration-tests/log-capture-hooks-agent/app.js
# Prints: App listening on http://127.0.0.1:<PORT>
```

---

## How the capture pipeline works

```
  logger.info(...)
       │
       ▼
  dd-trace instrumentation hook
  (apm:pino:log:json / apm:winston:log / apm:bunyan:log diagnostic channel)
       │
       ▼
  LogPlugin / PinoPlugin
  • injects dd trace context (if DD_LOGS_INJECTION=true)
  • serialises the record to JSON
       │
       ▼
  log-capture/sender.js
  • buffers records in memory
  • flushes as NDJSON over HTTP on a configurable interval
       │
       ▼
  mock-intake (or real Datadog log intake)
```

The hook fires **before** the logger writes to any transport, so a null sink
(no real output destination) is sufficient to exercise the full capture path.
