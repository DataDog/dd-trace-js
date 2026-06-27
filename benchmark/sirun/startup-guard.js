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
const OPERATIONS = Number(process.env.OPERATIONS)

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
  const duration = Number(end - loopStartedAt)

  if (duration < 5e9) {
    assert.fail('startup-guard: the loop duration is too short (<5s)')
  }

  reportOps(duration)

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

  if (share > maxShare) {
    assert.fail(
      `startup-guard: load+setup was ${(share * 100).toFixed(1)}% of the run ` +
      `(max ${(maxShare * 100).toFixed(0)}%); grow the loop or load fewer modules up front`
    )
  }
  if (maxShare - share > 0.05) {
    assert.fail(
      `startup-guard: the startup share is too high: ${(share * 100).toFixed(1)}% ` +
      `(max ${(maxShare * 100 + 5).toFixed(0)}%)`
    )
  }
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

  statsd ??= new (require('./statsd'))()
  statsd.gauge(path.basename(process.cwd()) + '.ops', OPERATIONS * 1e9 / duration)
  statsd.flush()
}

module.exports = { loopStart, done }
