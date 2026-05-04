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
   ▼  createSandbox → packTarballWithLock
pack-instrumented-tarball.js
   │  (bun pm pack → extract → istanbul instrument → sentinel → tar -czf)
   ▼  each spawn/fork/exec of Node
child-bootstrap.js  ──▶ require('nyc').wrap() [hookRequire: false]
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
| `pack-instrumented-tarball.js` | Runs during tarball packing when coverage is active. Extracts the `bun pm pack` output, pre-instruments every dd-trace source with `istanbul-lib-instrument`, drops the `.nyc-pre-instrumented` sentinel, and repacks. |
| `finalize-sandbox.js` | Called before a sandbox is removed. Reads the sandbox's raw coverage, rebases absolute paths from `<sandbox>/…` to `<repo>/…`, writes into the collector. |
| `merge-lcov.js` | Merges all per-sandbox `coverage-final.json` into a single LCOV + HTML report. |
| `nyc.sandbox.config.js` | NYC config used *inside* the sandboxes. Inherits `include`/`exclude` from the root `nyc.config.js`. Flips `hookRequire: false` automatically when the sandbox is pre-instrumented. |

## Environment variables

| Name | Purpose |
| --- | --- |
| `_DD_TRACE_INTEGRATION_COVERAGE_ROOT` | Set to the resolved dd-trace root. Presence activates the harness for the whole process tree. |
| `_DD_TRACE_INTEGRATION_COVERAGE_COLLECTOR` | Optional override for the collector directory. |
| `_DD_TRACE_INTEGRATION_COVERAGE_DISABLE` | Per-spawn opt-out. Set in the child env you pass to `fork`/`exec`/`spawn` when NYC's require-hook would break the fixture (e.g. timing-sensitive DI breakpoint races). The subtree runs without instrumentation. |
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

## Pre-instrumented tarballs

Under the coverage harness, `packTarballWithLock` delegates to
`pack-instrumented-tarball.js`: `bun pm pack` into a scratch tgz, extract, rewrite every
file matching `nyc.config.js` via `istanbul-lib-instrument` under the virtual root
`/__DD_TRACE_PRE_INSTRUMENTED__/<repo-relative>`, drop a `.nyc-pre-instrumented` sentinel,
repack. The placeholder root keeps every `cov_*` helper's embedded `path:` literal stable
across sandbox installs so merged coverage maps collapse cleanly.

At child startup, `child-bootstrap.js` checks the sentinel via `isPreInstrumentedSandbox()`
and either installs the nyc-free `pre-instrumented-writer` (fast path) or falls back to
`installRuntimeInstrumentation()` (legacy `TESTING_NO_INTEGRATION_SANDBOX=1`).
`finalize-sandbox.js` uses the placeholder root as the rebase pivot so merged LCOV paths
resolve to `<REPO_ROOT>/…` either way.

Cache policy is whatever `packTarballWithLock`'s `existsSync(tarballPath)` says; delete the
tarball at `$DD_TEST_SANDBOX_TARBALL_PATH` to force a rebuild.
`scripts/check-no-coverage-artifacts.js` keeps the sentinel out of committed trees.

## Running multiple `*:coverage` scripts in parallel

Every per-run artifact (collector dir, tarball cache, final LCOV) is scoped by
`npm_lifecycle_event`, so running e.g. `npm run test:integration:mocha:coverage`
and `npm run test:integration:cucumber:coverage` simultaneously in the same
checkout does not race on shared state.

## Coverage-sensitive timeouts

Pre-instrumentation moves the istanbul-lib-instrument cost out of every child's
require hook and into a single sandbox pack-time pass, so the residual per-child
overhead is small enough that no integration test currently needs to react to
whether coverage is active. If a suite starts flaking under coverage, prefer
re-introducing a small `COVERAGE_SLOWDOWN` constant in `runtime.js` over
bumping a single test's timeout — that keeps the override in one place.

## Known gaps

- **Mocha `ci:mocha:session:finish`**: LCOV shows the inner closure of
  `getOnEndHandler()` as never executed even though the plugin receives the event.
  The pre-instrumented writer mitigates this via `installLastExitHandler` (re-registers
  itself whenever a new `'exit'` listener appears so it always runs last); plugin
  teardown that touches dd-trace files inside its own exit listener is now captured.
  Anything emitted off mocha's runner *before* `'exit'` was already covered.
- **Dynamic-instrumentation retry test** (`mocha@*:runs retries with dynamic
  instrumentation`) opts out via `_DD_TRACE_INTEGRATION_COVERAGE_DISABLE` — even with
  pre-instrumentation the bootstrap adds enough child startup overhead to race the
  Inspector probe arming against the single DI retry window.
- **Jest + pre-instrumented dd-trace share `global.__coverage__`**:
  `getAllCoverageInfoCopy` deep-copies the whole map without consulting
  `coveragePathIgnorePatterns`. `pre-instrumented-writer.js` Proxies `global.__coverage__`
  so enumeration skips `PRE_INSTRUMENTED_ROOT`-rooted keys while direct access still
  works; the flush writes the raw object so our own coverage map stays complete.
- **Foreign nyc + pre-instrumented dd-trace** (cucumber's `nyc --all ...` fixtures):
  the bootstrap installs the enumeration shield but skips its own writer to avoid
  fighting the foreign nyc, so the dd-trace counters incremented inside that subtree
  are dropped. Tracked as a `TODO(BridgeAR)` in `child-bootstrap.js` —
  the fix is to flush only `PRE_INSTRUMENTED_ROOT`-keyed entries to our own collector
  while leaving the foreign nyc's view untouched.

## Zero-test matrix combinations

Some matrix combos filter every spec at runtime (e.g. cucumber's
`NODE_MAJOR === 18 && version === 'latest'` guard, cypress's
`shouldTestsRun()`). When no sandbox was spawned, `merge-lcov.js` writes
a `.skipped` marker file and `scripts/verify-coverage.js` honors it so
the CI job passes without trying to upload an empty report.

## Troubleshooting

- **"No sandbox coverage reports found to merge"** — either coverage isn't
  active (`_DD_TRACE_INTEGRATION_COVERAGE_ROOT` not set) or every sandbox
  exited without writing `.json` files. Confirm `child-bootstrap.js` is
  preloaded (grep the failing command's `NODE_OPTIONS` in logs).
- **Coverage from a sandbox is missing** — the sandbox's `tempDir` under
  `.nyc_output/integration-tests/` should contain one JSON per Node process.
  Empty means NYC never wrapped, which usually indicates a *foreign* NYC
  already set `NYC_CONFIG` pointing outside our tree (see `hasForeignNyc`
  in `child-bootstrap.js`).
- **Tests flake under coverage** — bump `COVERAGE_SLOWDOWN` usage in the
  affected spec before raising the whole-file timeout.
