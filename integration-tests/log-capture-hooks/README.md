# Log Capture Hook Integration Tests

End-to-end tests for the hook-based log capture feature, which forwards JSON log
records from Winston, Bunyan, and Pino to a configurable HTTP intake without
requiring transports or stream shims in user code.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Running All Tests](#running-all-tests)
- [Running Tests Individually](#running-tests-individually)
  - [A — Disabled Capture](#a--disabled-capture)
  - [B — logInjection=false Pino Re-enrichment](#b--loginjectionfalse-pino-re-enrichment)
  - [C — Pino Completeness (apm:pino:log:json vs apm:pino:log)](#c--pino-completeness-ampinologjson-vs-ampinolog)
  - [1 — Winston Capture](#1--winston-capture)
  - [2 — Bunyan Capture](#2--bunyan-capture)
  - [3 — Pino Capture](#3--pino-capture)
  - [4 — Exit Flush](#4--exit-flush)
- [Intake Server](#intake-server)
- [Test Architecture](#test-architecture)

---

## Overview

| ID | File | What it tests | Needs intake server | Self-asserting |
|----|------|---------------|---------------------|----------------|
| A  | `test-disabled.js` | No records forwarded when capture is disabled | No (inline) | Yes — exits 1 on failure |
| B  | `test-log-injection-off.js` | Pino records carry `dd` trace context even when `DD_LOGS_INJECTION=false` | No (inline) | Yes — exits 1 on failure |
| C  | `test-pino-completeness.js` | `apm:pino:log:json` (complete) vs `apm:pino:log` (pino-pretty only) | No | Yes — stdout pass/fail |
| 1  | `test-winston-capture.js` | 5 Winston records forwarded to intake with `dd` context | Yes | Via `/stats` in runner |
| 2  | `test-bunyan-capture.js` | 5 Bunyan records forwarded (complete: `pid`, `hostname`, `time`) | Yes | Via `/stats` in runner |
| 3  | `test-pino-capture.js` | 5 Pino records forwarded via `wrapAsJson` hook (complete for all versions) | Yes | Via `/stats` in runner |
| 4  | `test-exit-flush.js` | Buffered records flushed via `beforeExitHandlers` on natural process exit | Yes | Via `/stats` in runner |

---

## Prerequisites

- Node.js ≥ 18
- Logger packages: `winston`, `bunyan`, `pino` — declared in the local `package.json`
  inside this directory (not the repo root). The shell runner installs them
  automatically on first run. To install manually:

  ```bash
  cd integration-tests/log-capture-hooks
  yarn install
  ```

---

## Running All Tests

From the repo root:

```bash
./integration-tests/log-capture-hooks/run-capture-tests.sh
```

The runner:
- Installs missing logger dependencies automatically from the local `package.json`
- Starts the intake server on port 19876 if nothing is already listening there
- Runs all 7 tests in order
- Asserts record counts via the intake server's `/stats` endpoint between tests
- Shuts down the managed intake server on exit
- Prints a structured pass/fail summary and exits non-zero if any test fails

Example output:

```
Hook-Based Log Capture — Integration Test Suite
================================================

Checking logger dependencies ... ok
Intake server on :19876 ... started (pid 12345)

=== Assertion tests (self-contained, inline servers) ===

  disabled capture — 0 records forwarded ...        PASS
  logInjection=false — Pino re-enrichment (3 records + dd context) ...PASS

=== Completeness test (stdout-only, no intake) ===

  pino apm:pino:log:json completeness check ...      PASS

=== Capture tests (intake server on :19876) ===

  Winston — 5 records with dd context ...           PASS
  Bunyan — 5 complete records (pid, hostname, time) ...PASS
  Pino wrapAsJson — 5 complete records ...          PASS
  Exit flush (beforeExitHandlers, 30s interval) — 3 records ...PASS

================================================
  Results: 7/7 passed  ✅ all green
================================================
```

---

## Running Tests Individually

> **Before running any test individually**, ensure local dependencies are installed:
> ```bash
> cd integration-tests/log-capture-hooks && yarn install
> ```
> The shell runner does this automatically; individual scripts do not.

### A — Disabled Capture

**File:** `test-disabled.js`  
**Intake server:** not required (runs its own inline server on a random port)  
**Exits:** 0 on pass, 1 on failure

Verifies that no records reach the capture sender when `DD_LOG_CAPTURE_ENABLED` is
unset. Logs via all three loggers inside an active span with `DD_LOGS_INJECTION=true`
(plugin active for injection) to exercise the `_captureEnabled` gate specifically.

```bash
node integration-tests/log-capture-hooks/test-disabled.js
```

---

### B — logInjection=false Pino Re-enrichment

**File:** `test-log-injection-off.js`  
**Intake server:** not required (runs its own inline server on a random port)  
**Exits:** 0 on pass, 1 on failure

Verifies that Pino records are forwarded with `dd.trace_id` and `dd.span_id` even
when `DD_LOGS_INJECTION=false`. When log injection is off, the serialised JSON has
no `dd` field. `PinoPlugin.handleJsonLine` detects this via the `!shouldInject`
branch and re-injects trace context from the active span before forwarding.

```bash
node integration-tests/log-capture-hooks/test-log-injection-off.js
```

---

### C — Pino Completeness (apm:pino:log:json vs apm:pino:log)

**File:** `test-pino-completeness.js`  
**Intake server:** not required  
**Exits:** 0 always (stdout-only diagnostic)

Demonstrates that `apm:pino:log:json` always provides a complete log record (with
`time`, `pid`, `hostname`, `level`, `msg`) for all Pino versions, while `apm:pino:log`
is only published by `pino-pretty` and therefore not observed for regular Pino usage.

```bash
node integration-tests/log-capture-hooks/test-pino-completeness.js
```

Expected output:

```
--- apm:pino:log (pino-pretty only — not published for regular pino) ---
  (no record received — expected for regular pino without pino-pretty)

--- apm:pino:log:json (wrapAsJson — always complete) ---
  dd:       ✅ present
  msg:      ✅ present
  pid:      ✅ present
  hostname: ✅ present
  time:     ✅ present
  msg value: completeness check message

✅ CONFIRMED: apm:pino:log:json provides the complete record for all Pino versions.
```

---

### 1 — Winston Capture

**File:** `test-winston-capture.js`  
**Intake server:** required on port 19876  
**Exits:** 0 always (record count verified by runner via `/stats`)

Writes 5 records via Winston (no HTTP transport added — forwarding via
`apm:winston:log` diagnostic channel) and waits 300 ms for the periodic flush to
deliver them.

```bash
# Terminal 1
node integration-tests/log-capture-hooks/test-intake-server.js

# Terminal 2
node integration-tests/log-capture-hooks/test-winston-capture.js
```

Expected: 5 records at the intake server, each with `dd.trace_id`, `dd.span_id`,
`dd.service`, `dd.env`, `dd.version`.

---

### 2 — Bunyan Capture

**File:** `test-bunyan-capture.js`  
**Intake server:** required on port 19876  
**Exits:** 0 always (record count verified by runner via `/stats`)

Writes 5 records via Bunyan (null stream sink — forwarding via `apm:bunyan:log`
diagnostic channel). The logger and stream are both configured at `level: 'trace'`
so all log levels pass through to `_emit` where the hook fires.

> **Note:** Bunyan's instrumentation hooks `_emit`, which is called per stream after
> level filtering. Records below the stream's configured minimum level are never seen
> by the hook. If you reduce the stream level, the captured record count will decrease
> accordingly.

```bash
# Terminal 1
node integration-tests/log-capture-hooks/test-intake-server.js

# Terminal 2
node integration-tests/log-capture-hooks/test-bunyan-capture.js
```

Expected: 5 records with `pid`, `hostname`, `time`, `msg`, `name`, `v`, and `dd` context.

---

### 3 — Pino Capture

**File:** `test-pino-capture.js`  
**Intake server:** required on port 19876  
**Exits:** 0 always (record count verified by runner via `/stats`)

Writes 5 records via Pino. Capture uses the `wrapAsJson` hook
(`apm:pino:log:json` channel) so records are complete for all Pino versions.

```bash
# Terminal 1
node integration-tests/log-capture-hooks/test-intake-server.js

# Terminal 2
node integration-tests/log-capture-hooks/test-pino-capture.js
```

Expected: 5 records with `time` (numeric ms), `pid`, `hostname`, `level` (numeric),
`msg`, and `dd` context.

---

### 4 — Exit Flush

**File:** `test-exit-flush.js`  
**Intake server:** required on port 19876  
**Exits:** 0 always (record count verified by runner via `/stats`)

Verifies that buffered records are delivered on natural process exit even when the
periodic flush timer never fires. Sets `DD_LOG_CAPTURE_FLUSH_INTERVAL_MS=30000`
(30 s) so the timer is irrelevant, writes one log via each logger, then lets the
event loop drain. The `beforeExitHandlers` flush registered by `LogPlugin` delivers
all 3 records.

> **Important:** This test must exit naturally — do not add `process.exit()` calls.
> `process.exit()` bypasses the `beforeExit` event and prevents the flush from running.

```bash
# Terminal 1
node integration-tests/log-capture-hooks/test-intake-server.js

# Terminal 2
node integration-tests/log-capture-hooks/test-exit-flush.js
```

Expected: 3 records (one Winston, one Bunyan, one Pino) at the intake server despite
the 30 s flush interval never firing.

---

## Intake Server

**File:** `test-intake-server.js`

A lightweight NDJSON HTTP server used by tests 1–4 and the shell runner.

```bash
node integration-tests/log-capture-hooks/test-intake-server.js
```

Listens on port 19876. Endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/` | Receive NDJSON log records; prints each to stdout |
| `GET`  | `/stats` | Returns `{"received": N}` — total records since last reset |
| `POST` | `/reset` | Resets the counter to 0 (used by the runner between tests) |

Stop with `Ctrl-C`. Prints total records received on shutdown.

---

## Test Architecture

```
run-capture-tests.sh
│
├── Assertion tests (self-contained — no shared server)
│   ├── test-disabled.js          inline server, dynamic port, exits 1 on failure
│   └── test-log-injection-off.js inline server, dynamic port, exits 1 on failure
│
├── Completeness test (stdout only)
│   └── test-pino-completeness.js subscribes to channels directly, no HTTP
│
└── Capture tests (shared intake server on :19876)
    ├── test-winston-capture.js   flushIntervalMs=100, waits 300 ms
    ├── test-bunyan-capture.js    flushIntervalMs=100, waits 300 ms
    ├── test-pino-capture.js      flushIntervalMs=100, waits 300 ms
    └── test-exit-flush.js        flushIntervalMs=30000, natural exit via beforeExitHandlers
```

**Capture path per logger:**

| Logger | Channel | Hook point | Record completeness |
|--------|---------|------------|---------------------|
| Winston | `apm:winston:log` | `write()` shim | Partial (no `pid`/`hostname`) |
| Bunyan | `apm:bunyan:log` | `_emit` wrap | Complete (after stream level filter) |
| Pino | `apm:pino:log:json` | `wrapAsJson` (`asJsonSym` wrap) | Always complete (all versions) |
