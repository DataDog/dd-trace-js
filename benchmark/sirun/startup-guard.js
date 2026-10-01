'use strict'

// Measured-loop boundary. Sirun excludes everything before loopStart() from its
// timing and instruction metrics. A full GC immediately before the ready signal
// gives every iteration a consistent post-warmup heap state.
//
//   const guard = require('../startup-guard')
//   // ...requires, setup...
//   guard.loopStart()
//   for (...) { ... }
//   guard.done()

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

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
  if (readyFd) fs.writeSync(Number.parseInt(readyFd, 10), 'x')
}

function done () {
  const end = process.hrtime.bigint()
  assert.ok(loopStartedAt !== undefined, 'measurement boundary: loopStart() was never called')
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
