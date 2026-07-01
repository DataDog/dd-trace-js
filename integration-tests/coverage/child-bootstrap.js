'use strict'

// Preloaded (via NODE_OPTIONS=--require) into every Node descendant of the mocha process.
//
// Under native V8 coverage this does NO instrumentation — V8 records coverage on its own from the
// inherited NODE_V8_COVERAGE directory. It has two jobs:
//   1. Re-install the child_process / worker_threads patch so a *grandchild* spawned with a custom
//      `env` (which would otherwise drop the inherited NODE_V8_COVERAGE) still gets it injected.
//   2. Flush V8 coverage on the termination signals the harness uses to stop long-running fixtures.
//      V8 only writes the profile on a clean exit; a server killed with SIGTERM/SIGINT would lose
//      its coverage, so we call `v8.takeCoverage()` then exit cleanly on those signals.

const v8 = require('node:v8')

const preloadList = require('node-preload')

const { installPatch } = require('./patch-child-process')
const {
  DISABLE_ENV,
  ROOT_ENV,
  canonicalizePath,
  isCoverageActive,
  prependBootstrapRequire,
  resolveCoverageRoot,
} = require('./runtime')

const BOOTSTRAPPED = Symbol.for('dd-trace.integration-coverage.bootstrapped')

if (isCoverageActive() && !process.env[DISABLE_ENV] && !globalThis[BOOTSTRAPPED]) {
  globalThis[BOOTSTRAPPED] = true
  bootstrapCoverage()
}

function bootstrapCoverage () {
  const coverageRoot = resolveCoverageRoot({ cwd: process.env[ROOT_ENV] || process.cwd() })
  if (!coverageRoot) return

  // Keep the resolved root and the bootstrap require on this process' own env so anything it
  // spawns with the default env inherits both (the child_process patch handles custom-env spawns).
  process.env[ROOT_ENV] = canonicalizePath(coverageRoot)
  process.env.NODE_OPTIONS = prependBootstrapRequire(process.env.NODE_OPTIONS)
  if (!preloadList.includes(__filename)) preloadList.push(__filename)

  installPatch()
  installCoverageFlush()
}

/**
 * Flush V8 coverage when the harness terminates a long-running fixture. `helpers#stopProc` sends
 * SIGTERM (then escalates to SIGKILL, which we can't intercept). On SIGTERM/SIGINT we write the
 * profile via `v8.takeCoverage()` and exit cleanly so the data lands in NODE_V8_COVERAGE; without
 * this a killed server contributes no coverage. We add listeners with `process.once` and only act
 * when we're the sole listener for the signal, so a fixture with its own handler keeps control.
 *
 * @returns {void}
 */
function installCoverageFlush () {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      try {
        v8.takeCoverage()
      } catch {}
      // Only force exit if no other handler did; mirrors the default signal disposition.
      if (process.listenerCount(signal) === 0) {
        process.exit(0)
      }
    })
  }
}
