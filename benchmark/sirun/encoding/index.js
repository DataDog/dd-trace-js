'use strict'

const assert = require('node:assert/strict')

const {
  ENCODER_VERSION,
  WITH_SPAN_EVENTS = 'none',
  TRACE_SPANS,
} = process.env

const { AgentEncoder } = require(`../../../packages/dd-trace/src/encode/${ENCODER_VERSION}`)
const { buildTrace, attachFreshEvents } = require('./trace-fixture')

const writer = { flush: () => {} }
const trace = buildTrace(TRACE_SPANS ? Number(TRACE_SPANS) : 30)

const encoder = new AgentEncoder(writer)

// Pre-flight: one cycle to confirm encoder state actually advances; catches a
// silent breakage where the fixture or loader skipped the encode path.
if (WITH_SPAN_EVENTS !== 'none') attachFreshEvents(trace)
encoder.encode(trace)
assert.equal(encoder.count(), 1)
assert.ok(encoder._traceBytes.length > 0)
encoder._reset()

if (WITH_SPAN_EVENTS === 'none') {
  for (let iteration = 0; iteration < 5000; iteration++) {
    encoder.encode(trace)
  }
} else {
  for (let iteration = 0; iteration < 5000; iteration++) {
    attachFreshEvents(trace)
    encoder.encode(trace)
  }
}
