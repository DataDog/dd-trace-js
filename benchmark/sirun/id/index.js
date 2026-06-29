'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')
const id = require('../../../packages/dd-trace/src/id')

const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

// id() with no argument generates a pseudo-random 64-bit id from a batch buffer
// that refills every 8192 draws -- the per-span and per-trace cost. id(hex, 16)
// parses an inbound trace/span id from a distributed-tracing header (64-bit span
// id, 128-bit trace id). Both run on the request hot path and are not measured
// elsewhere. toArray() is the call the encoder makes to read the id onto the
// wire, so it stands in for "the id is actually used".
const HEX_64 = 'abcdef1234567890'
const HEX_128 = '1234567890abcdef1234567890abcdef'

let run
if (VARIANT === 'parse-64bit') {
  run = () => id(HEX_64, 16).toArray().length
} else if (VARIANT === 'parse-128bit') {
  run = () => id(HEX_128, 16).toArray().length
} else {
  run = () => id().toArray().length
}

// Preflight: every variant must yield the 8-byte wire array (a 128-bit id keeps
// its low 8 bytes), so a broken path can't silently measure a no-op.
assert.equal(run(), 8, 'id did not yield an 8-byte wire array')

let sink = 0
guard.loopStart()
for (let i = 0; i < OPERATIONS; i++) {
  sink += run()
}
guard.done()

assert.ok(sink > 0, 'id bench produced no work')
