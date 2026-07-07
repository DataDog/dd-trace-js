'use strict'

// Preloaded (via NODE_OPTIONS=--require) into every Node descendant of the mocha process.
//
// Under native V8 coverage this does NO instrumentation — V8 records coverage on its own from the
// inherited NODE_V8_COVERAGE directory. It has two jobs:
//   1. Re-install the child_process / worker_threads patch so a *grandchild* spawned with a custom
//      `env` (which would otherwise drop the inherited NODE_V8_COVERAGE) still gets it injected.
//   2. Flush V8 coverage when the harness *forcefully* stops a long-running fixture — SIGTERM/SIGINT
//      on POSIX, the IPC sentinel on Windows (where SIGTERM is forceful and skips a signal hook).
//      V8 only writes the profile on a clean exit, so we call `v8.takeCoverage()` then exit cleanly.
//      A gracefully-exiting child needs none of this: V8 writes its profile on teardown by itself.

const v8 = require('node:v8')

const preloadList = require('node-preload')

const { installPatch } = require('./patch-child-process')
const {
  COPY_BACK_ENV,
  DISABLE_ENV,
  FLUSH_SIGNAL_KEY,
  ROOT_ENV,
  V8_COVERAGE_ENV,
  canonicalizePath,
  copyV8ProfilesSync,
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
  installWindowsFlush()
}

/**
 * Write this process' V8 coverage to disk, and — when we left a foreign `NODE_V8_COVERAGE` in place
 * (`COPY_BACK_ENV` set) — copy the resulting profiles into our collector. Only used on the forceful
 * stop paths below, where the process is about to die: `v8.takeCoverage()` resets the execution
 * counters, but there is no surviving consumer of the child's own coverage to be disturbed by that.
 * A gracefully-exiting foreign-directory child is handled parent-side in `helpers#stopProc`, which
 * copies *after* V8's own single teardown write, so its counters are never split.
 *
 * @returns {void}
 */
function flushCoverage () {
  try {
    v8.takeCoverage()
  } catch {}
  copyV8ProfilesSync(process.env[V8_COVERAGE_ENV], process.env[COPY_BACK_ENV])
}

/**
 * Flush V8 coverage when the harness terminates a long-running fixture with a signal.
 * `helpers#stopProc` sends SIGTERM (then escalates to SIGKILL, which we can't intercept). We add
 * listeners with `process.once` and only force the exit when we're the sole listener for the
 * signal, so a fixture with its own handler keeps control.
 *
 * @returns {void}
 */
function installCoverageFlush () {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      flushCoverage()
      // Only force exit if no other handler did; mirrors the default signal disposition.
      if (process.listenerCount(signal) === 0) {
        process.exit(0)
      }
    })
  }
}

/**
 * Windows SIGTERM is forceful and skips the signal hook above, so `helpers#stopProc` asks a
 * connected child to flush via an IPC sentinel instead. Flush and exit cleanly on receipt.
 * `unrefCounted` keeps this listener from holding an otherwise-idle fixture open.
 *
 * @returns {void}
 */
function installWindowsFlush () {
  if (process.platform !== 'win32') return
  process.on('message', message => {
    if (message?.[FLUSH_SIGNAL_KEY] === true) {
      flushCoverage()
      process.exit(0)
    }
  })
  const channel = /** @type {{ unrefCounted?: () => void } | null | undefined} */ (
    /** @type {unknown} */ (process.channel)
  )
  channel?.unrefCounted?.()
}
