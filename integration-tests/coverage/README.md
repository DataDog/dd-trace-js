# Integration Test Coverage Harness

How the `*:coverage` scripts under `integration-tests/` collect code coverage
across every child process they spawn.

## Why a custom harness?

Integration tests frequently `fork`, `spawn`, or `exec` new Node processes
(`run-mocha.js`, `createSandbox`, plugin fixtures, etc.). Coverage that only
watches the direct mocha process therefore misses most real production code,
which runs in those descendants.

The harness solves that by pointing **every** Node descendant at a shared
[native V8 coverage](https://nodejs.org/api/cli.html#node_v8_coveragedir)
directory (`NODE_V8_COVERAGE`) and converting the collected profiles into a
single repo-level LCOV that Codecov picks up the same way it picks up unit-test
coverage. There is no source instrumentation: V8 records execution directly, so
ESM, `eval`, and source-mapped files are all covered without a transform.

All sources live in `integration-tests/coverage/`.

## High-level flow

```md
npm run test:integration:mocha:coverage
  │
  ▼
integration-tests/coverage/run-suite.js
  │  resets the collector, sets this process' NODE_V8_COVERAGE,
  │  spawns mocha with --require register.js
  ▼
register.js  ──▶ patch-child-process.js  (monkey-patches child_process / Worker)
  │
  ▼  each fork/spawn/exec of Node
patch-child-process.js
  │  injects NODE_V8_COVERAGE (+ the bootstrap require) into the child env
  ▼
child-bootstrap.js  (re-installs the patch so deeper custom-env spawns keep the
  │                  directory; flushes via v8.takeCoverage() on SIGTERM/SIGINT)
  ▼  V8 writes one raw coverage JSON per process into the collector
merge-lcov.js  (called by run-suite.js after mocha exits; converts every V8
                profile via v8-to-istanbul into coverage/node-<version>-<script>/lcov.info)
```

## Key files

| File | Role |
| --- | --- |
| `runtime.js` | Shared constants/helpers (paths, env vars, `applyCoverageEnv`, `resolveCoverageRoot`, `getV8CoverageDir`). |
| `run-suite.js` | Entry point. Resets the collector, points mocha's `NODE_V8_COVERAGE` at it, runs mocha, then the merger. |
| `register.js` | Preloaded into mocha; installs the `child_process` / `Worker` patches. |
| `patch-child-process.js` | Rewrites options for `fork`/`spawn`/`exec`/`Worker` so every Node descendant inherits `NODE_V8_COVERAGE` and the bootstrap require. |
| `child-bootstrap.js` | Preloaded into every child. Re-installs the patch (for deeper custom-env spawns) and flushes V8 coverage on the termination signals the harness uses to stop long-running fixtures. Does **no** instrumentation. |
| `merge-lcov.js` | Converts every per-process V8 profile in the collector via `v8-to-istanbul` (same `include`/`exclude` as `nyc.config.js`) into a single LCOV + HTML report. |

## Environment variables

| Name | Purpose |
| --- | --- |
| `NODE_V8_COVERAGE` | Node's native coverage output directory. Pointed at the shared collector for every process in the tree. |
| `_DD_TRACE_INTEGRATION_COVERAGE_ROOT` | Set to the resolved dd-trace root. Presence activates the harness for the whole process tree. |
| `_DD_TRACE_INTEGRATION_COVERAGE_COLLECTOR` | Optional override for the collector directory. |
| `_DD_TRACE_INTEGRATION_COVERAGE_DISABLE` | Per-spawn opt-out. Set it in the child env you pass to `fork`/`exec`/`spawn` to run that subtree without coverage. The harness blanks `NODE_V8_COVERAGE` for the child (omitting is not enough — Node copies the parent's value to children otherwise). |

## Output layout

```sh
.nyc_output/integration-tests-collector-<script>/
    v8/coverage-*.json     # one raw V8 profile per process

coverage/node-<version>-<script>/
    lcov.info          # merged LCOV Codecov uploads
    coverage-final.json
    html/              # HTML report for local inspection
```

The output path intentionally matches `nyc.config.js` (`coverage/node-<version>-<label>`)
so Codecov and `scripts/verify-coverage.js` treat integration and unit reports identically.

## In-process suites (`test:*:ci`)

The non-integration suites run their product code inside the mocha process
itself, so they don't need the spawn-propagation harness. They run under
[`c8`](https://github.com/bcoe/c8) via `scripts/c8-ci.js`, which wraps the
`node init` warm-up and the test run in one shared temp directory and reports
into the same `coverage/node-<version>-<label>` layout.

## The line-coverage patch

V8 seeds every line as covered and only zeroes a line when a `count: 0` range
spans it *entirely*. An indented, un-taken arm of a multi-line statement (a
ternary/logical arm on its own line) is therefore left reported as covered.
`scripts/patch-v8-to-istanbul.js` (applied in `prepare`) widens the zeroing
guard to also zero a line covered from its first non-whitespace column through
the line end, matching istanbul's statement-granular result. Both the harness
merger and `c8` use that patched copy.

## Running multiple `*:coverage` scripts in parallel

Every per-run artifact (collector dir, final LCOV) is scoped by
`npm_lifecycle_event`, so running e.g. `npm run test:integration:mocha:coverage`
and `npm run test:integration:cucumber:coverage` simultaneously in the same
checkout does not race on shared state.

## Long-running fixtures and signals

V8 writes its coverage profile only on a clean exit. A server-style fixture that
the harness stops with `SIGTERM` would otherwise contribute nothing, so
`child-bootstrap.js` intercepts `SIGTERM`/`SIGINT`, calls `v8.takeCoverage()`,
and exits cleanly. A fixture killed with `SIGKILL` cannot be intercepted and
will not contribute coverage — prefer `SIGTERM` when stopping coverage-relevant
processes.

## Zero-test matrix combinations

Some matrix combos filter every spec at runtime (e.g. cucumber's
`NODE_MAJOR === 18 && version === 'latest'` guard, cypress's `shouldTestsRun()`).
When no coverage was produced, `merge-lcov.js` writes a `.skipped` marker file
and `scripts/verify-coverage.js` honors it so the CI job passes without trying to
upload an empty report.

## Troubleshooting

- **"No V8 coverage data found to merge"** — either coverage isn't active
  (`_DD_TRACE_INTEGRATION_COVERAGE_ROOT` not set) or every process exited without
  writing a profile. Confirm `NODE_V8_COVERAGE` is set in the failing command's
  environment.
- **Coverage from a sandbox is missing** — the collector's `v8/` directory should
  contain one JSON per Node process. A long-running fixture killed with `SIGKILL`
  (rather than `SIGTERM`) writes nothing; check how the spec stops its processes.
