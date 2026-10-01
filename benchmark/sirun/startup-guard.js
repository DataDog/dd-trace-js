'use strict'

// Startup-share guard. Require this FIRST in a loop benchmark so START captures
// the file's load time (the heavy requires that follow, especially the tracer).
// Call loopStart() right before the measured loop and done() right after it (for
// async loops, call done() from the completion callback). done() fails the run
// if load+setup grew past the allowed share of the total, which is the recurring
// way a bench rots into measuring startup instead of its hot path.
// Sirun also excludes everything before loopStart() from its timing and
// instruction metrics. A full GC immediately before the ready signal gives every
// iteration a consistent post-warmup heap state.
//
//   const guard = require('../startup-guard')
//   // ...requires, setup...
//   guard.loopStart()
//   for (...) { ... }
//   guard.done()            // default 7% ceiling
//   guard.done(0.15)        // relaxed ceiling when the loop legitimately can't dominate further

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const START = process.hrtime.bigint()
const OPERATIONS = Number(process.env.OPERATIONS)

let loopStartedAt
let statsd

function loopStart () {
  const readyFd = process.env.SIRUN_READY_FD
  if (process.env.SIRUN_STATSD_PORT !== undefined) {
    assert.ok(readyFd, 'SIRUN_READY_FD is required; install Sirun 0.1.12 or newer')
    assert.strictEqual(typeof global.gc, 'function', 'Sirun benchmarks must run Node.js with --expose-gc')
  }

  global.gc?.()
  loopStartedAt = process.hrtime.bigint()
  if (readyFd) {
    fs.writeSync(Number.parseInt(readyFd, 10), 'x')
  } else {
    process.stderr.write('startup-guard: SIRUN_READY_FD is not set, startup time will be included in measurements\n')
  }
}

/**
 * @param {number} [maxShare]
 */
function done (maxShare = 0.07) {
  const end = process.hrtime.bigint()
  assert.ok(loopStartedAt !== undefined, 'startup-guard: loopStart() was never called')
  const total = Number(end - START)
  const startup = Number(loopStartedAt - START)
  const share = total === 0 ? 1 : startup / total
  const loop = Number(end - loopStartedAt)

  reportOps(loop)

  // Report mode (used by the overview collector): write the share to the given
  // file and skip the assertion, so a high-startup variant still reports instead
  // of crashing the data run. Off in normal/CI runs, where the assertion gates.
  const reportPath = process.env.STARTUP_GUARD_REPORT
  if (reportPath) {
    try {
      require('fs').writeFileSync(reportPath, share.toFixed(4))
    } catch {}
    return
  }

  assert.ok(
    share <= maxShare,
    `startup-guard: load+setup was ${(share * 100).toFixed(2)}% of the run ` +
    `(setup ${(startup / 1e6).toFixed(1)}ms, loop ${(loop / 1e6).toFixed(1)}ms, ` +
    `max ${(maxShare * 100).toFixed(0)}%); grow the loop or load fewer modules up front`
  )
}

/**
 * Emit the loop's throughput as `<bench>.ops`, derived from the same window the
 * guard already measures. A missing OPERATIONS only warns for now: most benches
 * have a clean iteration count, but some measure bursts/cycles that don't map to
 * a single operation, and we don't want to fail those runs over a missing metric.
 *
 * @param {number} duration loop wall time in nanoseconds
 */
function reportOps (duration) {
  if (!OPERATIONS) {
    process.stderr.write('startup-guard: OPERATIONS is not set, skipping the operations-per-second metric\n')
    return
  }
  if (duration === 0) {
    return
  }

  statsd ??= new (require('./statsd'))()
  statsd.gauge(path.basename(process.cwd()) + '.ops', OPERATIONS * 1e9 / duration)
  statsd.flush()
}

module.exports = { loopStart, done }
