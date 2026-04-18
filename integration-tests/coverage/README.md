# Integration Test Coverage Harness

How the `*:coverage` scripts under `integration-tests/` collect code coverage
across every child process they spawn.

## Why a custom harness?

Integration tests frequently `fork`, `spawn`, or `exec` new Node processes
(`run-mocha.js`, `createSandbox`, plugin fixtures, etc.). The standard
`nyc ./node_modules/.bin/mocha …` flow only instruments the direct children,
so most real production code runs uninstrumented.

The harness solves that by injecting NYC into *every* Node descendant and
merging their reports back into a single repo-level LCOV that Codecov picks up
the same way it picks up unit-test coverage.

All sources live in `integration-tests/coverage/`.

## High-level flow

```md
npm run test:integration:mocha:coverage
   │
   ▼
integration-tests/coverage/run-suite.js
   │  (spawns mocha with --require register.js)
   ▼
register.js  ──▶ patch-child-process.js  (monkey-patches child_process)
   │
   ▼  each spawn/fork/exec of Node
child-bootstrap.js  ──▶ require('nyc').wrap()
   │  (child runs, writes raw coverage JSON to per-sandbox temp dir)
   ▼
useSandbox teardown
   │
   ▼
finalize-sandbox.js  (reads sandbox JSON, rebases paths to repo root,
                     writes coverage into the collector)
   │
   ▼
merge-lcov.js  (called by run-suite.js after mocha exits; merges every
                sandbox into coverage/node-<version>-<script>/lcov.info)
```

## Key files

| File | Role |
| --- | --- |
| `runtime.js` | Shared constants/helpers (paths, env vars, `applyCoverageEnv`, `resolveCoverageRoot`). |
| `run-suite.js` | Entry point. Runs mocha then the merger. |
| `register.js` | Preloaded into mocha; installs the `child_process` patches. |
| `patch-child-process.js` | Rewrites options for `fork`/`spawn`/`exec` so every Node descendant preloads the bootstrap. |
| `child-bootstrap.js` | Preloaded into every child. Bootstraps NYC and propagates itself into grandchildren via `node-preload`. |
| `finalize-sandbox.js` | Called before a sandbox is removed. Reads the sandbox's raw coverage, rebases absolute paths from `<sandbox>/…` to `<repo>/…`, writes into the collector. |
| `merge-lcov.js` | Merges all per-sandbox `coverage-final.json` into a single LCOV + HTML report. |
| `nyc.sandbox.config.js` | NYC config used *inside* the sandboxes. Inherits `include`/`exclude` from the root `nyc.config.js`. |
| `manual-process.js` | Escape hatch for integrations where `child_process` patching can't reach the inner Node process (e.g. `func`, wrapped CLI tools). |

## Environment variables

| Name | Purpose |
| --- | --- |
| `DD_TRACE_INTEGRATION_COVERAGE_ROOT` | Set to the resolved dd-trace root. Presence activates the harness for the whole process tree. |
| `DD_TRACE_INTEGRATION_COVERAGE_COLLECTOR` | Optional override for the collector directory. |
| `DD_TRACE_INTEGRATION_COVERAGE_DISABLE` | Per-spawn opt-out. Set in the child env you pass to `fork`/`exec`/`spawn` when NYC's require-hook would break the fixture (e.g. timing-sensitive DI breakpoint races). The subtree runs without instrumentation. |
| `NYC_CONFIG` / `NYC_PROCESS_ID` | Standard NYC variables propagated to children. |

## Output layout

```sh
.nyc_output/integration-tests-collector-<script>/
    sandboxes/<sandbox-hash>/coverage-final.json    # per-sandbox intermediate

coverage/node-<version>-<script>/
    lcov.info          # merged LCOV Codecov uploads
    coverage-final.json
    html/              # HTML report for local inspection
```

The output path intentionally matches `nyc.config.js` (`coverage/node-<version>-<label>`)
so Codecov and `scripts/verify-coverage.js` treat integration and unit reports identically.

## Running multiple `*:coverage` scripts in parallel

Every per-run artifact (collector dir, tarball cache, final LCOV) is scoped by
`npm_lifecycle_event`, so running e.g. `npm run test:integration:mocha:coverage`
and `npm run test:integration:cucumber:coverage` simultaneously in the same
checkout does not race on shared state.

## Coverage-sensitive timeouts

NYC instrumentation slows hot paths meaningfully. The `COVERAGE_SLOWDOWN`
constant in `runtime.js` (3x when coverage is active, 1x otherwise) is applied
in tests that poll telemetry endpoints or the intake. Use it instead of
bumping a single test's timeout.

## Known gaps

- **Mocha `ci:mocha:session:finish`**: LCOV shows the inner closure of
  `getOnEndHandler()` as never executed even though the plugin demonstrably
  receives the event (assertions on `test_session_end` payloads pass). The
  closure body writes its counter increments before the child exits, but NYC's
  exit hook writes coverage before those increments land in the file — a
  subtle ordering issue with mocha's synchronous `'end'` emission. Not an
  issue with the harness itself; fixing it would require changes to the
  instrumentation (e.g. synchronously flushing a marker before mocha's
  `run()` callback).
- **Dynamic-instrumentation retry test**: `mocha@*:runs retries with dynamic
  instrumentation` opts out via `DD_TRACE_INTEGRATION_COVERAGE_DISABLE`
  because NYC's require-hook delays child startup enough that DI's Inspector
  breakpoint isn't armed before the single retry completes.
- **Jest `calculates executable lines even if there have been skipped suites`**:
  also opts out via `DD_TRACE_INTEGRATION_COVERAGE_DISABLE`. NYC and jest both
  write to `global.__coverage__`, so jest's coverage map picks up every dd-trace
  file NYC instrumented in the same worker and the asserted `LINES_PCT` drops.

## Zero-test matrix combinations

Some matrix combos filter every spec at runtime (e.g. cucumber's
`NODE_MAJOR === 18 && version === 'latest'` guard, cypress's
`shouldTestsRun()`). When no sandbox was spawned, `merge-lcov.js` writes
a `.skipped` marker file and `scripts/verify-coverage.js` honors it so
the CI job passes without trying to upload an empty report.

## Troubleshooting

- **"No sandbox coverage reports found to merge"** — either coverage isn't
  active (`DD_TRACE_INTEGRATION_COVERAGE_ROOT` not set) or every sandbox
  exited without writing `.json` files. Confirm `child-bootstrap.js` is
  preloaded (grep the failing command's `NODE_OPTIONS` in logs).
- **Coverage from a sandbox is missing** — the sandbox's `tempDir` under
  `.nyc_output/integration-tests/` should contain one JSON per Node process.
  Empty means NYC never wrapped, which usually indicates a *foreign* NYC
  already set `NYC_CONFIG` pointing outside our tree (see `hasForeignNyc`
  in `child-bootstrap.js`).
- **Tests flake under coverage** — bump `COVERAGE_SLOWDOWN` usage in the
  affected spec before raising the whole-file timeout.
