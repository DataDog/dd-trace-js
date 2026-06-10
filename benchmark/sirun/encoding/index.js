'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const {
  ENCODER_VERSION,
  WITH_SPAN_EVENTS = 'none',
  TRACE_SPANS,
} = process.env

const WIDE_TAGS = Number(process.env.WIDE_TAGS) || 0
const ENCODE_COUNT = Number(process.env.ENCODE_COUNT) || 5000

const { AgentEncoder } = require(`../../../packages/dd-trace/src/encode/${ENCODER_VERSION}`)
const { buildTrace, tickTrace, attachFreshEvents } = require('./trace-fixture')

const writer = { flush: () => {} }
const trace = buildTrace(TRACE_SPANS ? Number(TRACE_SPANS) : 30)

// Wide-meta variant: append synthetic custom tags to every span so the encoder's
// per-tag meta-map loop (key + value write, string-cache lookup) dominates over
// the fixed ~15 production tags. Static values match the production cache-hit
// pattern for repeated custom keys.
if (WIDE_TAGS > 0) {
  for (const span of trace) {
    for (let i = 0; i < WIDE_TAGS; i++) {
      span.meta[`custom.tag.${i.toString().padStart(2, '0')}`] = `value-${i}`
    }
  }
}

const encoder = new AgentEncoder(writer)

// Pre-flight: one cycle to confirm encoder state actually advances; catches a
// silent breakage where the fixture or loader skipped the encode path.
tickTrace(trace, 0)
if (WITH_SPAN_EVENTS !== 'none') attachFreshEvents(trace, 0)
encoder.encode(trace)
assert.equal(encoder.count(), 1)
assert.ok(encoder._traceBytes.length > 0)
encoder._reset()

guard.loopStart()
if (WITH_SPAN_EVENTS === 'none') {
  for (let iteration = 0; iteration < ENCODE_COUNT; iteration++) {
    tickTrace(trace, iteration)
    encoder.encode(trace)
  }
} else {
  for (let iteration = 0; iteration < ENCODE_COUNT; iteration++) {
    tickTrace(trace, iteration)
    attachFreshEvents(trace, iteration)
    encoder.encode(trace)
  }
}
guard.done()
