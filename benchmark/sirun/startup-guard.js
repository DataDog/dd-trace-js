'use strict'

// Startup-share guard. Require this FIRST in a loop benchmark so START captures
// the file's load time (the heavy requires that follow, especially the tracer).
// Call loopStart() right before the measured loop and done() right after it (for
// async loops, call done() from the completion callback). done() fails the run
// if load+setup grew past the allowed share of the total, which is the recurring
// way a bench rots into measuring startup instead of its hot path.
//
//   const guard = require('../startup-guard')
//   // ...requires, setup...
//   guard.loopStart()
//   for (...) { ... }
//   guard.done()            // default 7% ceiling
//   guard.done(0.15)        // relaxed ceiling when the loop legitimately can't dominate further

const assert = require('node:assert/strict')
const path = require('node:path')

const START = process.hrtime.bigint()
const OPERATIONS = getOperations()

let loopStartedAt
let statsd

function loopStart () {
  loopStartedAt = process.hrtime.bigint()
  if (process.env.SIRUN_READY_FD) {
    require('fs').writeSync(parseInt(process.env.SIRUN_READY_FD), 'x')
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
    `startup-guard: load+setup was ${(share * 100).toFixed(1)}% of the run ` +
    `(max ${(maxShare * 100).toFixed(0)}%); grow the loop or load fewer modules up front`
  )
}

/**
 * @param {number} duration
 */
function reportOps (duration) {
  assert.ok(Number.isFinite(OPERATIONS) && OPERATIONS > 0,
    'startup-guard: OPERATIONS must be set to a positive number')
  assert.ok(duration !== 0, 'startup-guard: loop duration was zero')

  statsd ??= new (require('./statsd'))()
  statsd.gauge(path.basename(process.cwd()) + '.ops', OPERATIONS * 1e9 / duration)
  statsd.flush()
}

function getOperations () {
  return Number(process.env.OPERATIONS)
}

module.exports = { loopStart, done }
