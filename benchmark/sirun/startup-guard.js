'use strict'

// Loop timer and operations reporter. Call loopStart() immediately before the
// measured loop and done() immediately after it.
//
//   const guard = require('../startup-guard')
//   // ...requires, setup...
//   guard.loopStart()
//   for (...) { ... }
//   guard.done()

const assert = require('node:assert/strict')
const path = require('node:path')

const OPERATIONS = Number(process.env.OPERATIONS)

let loopStartedAt
let statsd

function loopStart () {
  loopStartedAt = process.hrtime.bigint()
  if (process.env.SIRUN_READY_FD) {
    require('fs').writeSync(parseInt(process.env.SIRUN_READY_FD, 10), 'x')
  } else {
    process.stderr.write('sirun benchmark: SIRUN_READY_FD is not set, startup time will be included in measurements\n')
  }
}

function done () {
  const end = process.hrtime.bigint()
  assert.ok(loopStartedAt !== undefined, 'sirun benchmark: loopStart() was never called')
  const loop = Number(end - loopStartedAt)

  reportOps(loop)
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
    process.stderr.write('sirun benchmark: OPERATIONS is not set, skipping the operations-per-second metric\n')
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
