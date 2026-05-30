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
//   guard.done()            // default 10% ceiling
//   guard.done(0.15)        // relaxed ceiling when the loop legitimately can't dominate further

const assert = require('node:assert/strict')

const START = process.hrtime.bigint()
let loopStartedAt

function loopStart () {
  loopStartedAt = process.hrtime.bigint()
}

function done (maxShare = 0.10) {
  const end = process.hrtime.bigint()
  assert.ok(loopStartedAt !== undefined, 'startup-guard: loopStart() was never called')
  const total = Number(end - START)
  const startup = Number(loopStartedAt - START)
  const share = total === 0 ? 1 : startup / total
  assert.ok(
    share <= maxShare,
    `startup-guard: load+setup was ${(share * 100).toFixed(1)}% of the run ` +
    `(max ${(maxShare * 100).toFixed(0)}%); grow the loop or load fewer modules up front`
  )
}

module.exports = { loopStart, done }
