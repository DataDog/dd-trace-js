'use strict'

const assert = require('node:assert/strict')

const {
  ENCODER_VERSION,
  WITH_SPAN_EVENTS = 'none',
} = process.env

const { AgentEncoder } = require(`../../../packages/dd-trace/src/encode/${ENCODER_VERSION}`)
const id = require('../../../packages/dd-trace/src/id')

const writer = {
  flush: () => {},
}

function createSpan (parent) {
  const spanId = id()
  return {
    trace_id: parent ? parent.trace_id : spanId,
    span_id: spanId,
    parent_id: parent ? parent.parent_id : id(0),
    name: 'this is a name',
    resource: 'this is a resource',
    error: 0,
    start: 1415926535897,
    duration: 100,
    meta: {
      a: 'b',
      hello: 'world',
      and: 'this is a longer string, just because we want to test some longer strongs, got it? okay',
    },
    metrics: {
      b: 45,
      something: 98764389,
      afloaty: 203987465.756754,
    },
  }
}

const trace = []
for (let parent = null, index = 0; index < 30; index++) {
  const span = createSpan(parent)
  trace.push(span)
  parent = span
}

const ATTR_TEMPLATE_HTTP_OK = { attempt: 1, ratio: 0.5, ok: true, kind: 'http.client', codes: [200, 204] }
const ATTR_TEMPLATE_HTTP_ERR = { attempt: 2, ratio: 0.6, ok: false, kind: 'http.server', codes: [500, 503] }
const ATTR_TEMPLATE_DB = { attempt: 3, ratio: 0.7, ok: true, kind: 'db.query', codes: [42] }

// `encoder.encode` consumes its input: the legacy path deletes `span.span_events`
// after writing `meta.events`; the native path wraps each attribute primitive into
// a typed object that the next pass would then drop. Rebuilding per iteration is
// the only way to measure the same encoder work on every iteration.
function attachFreshEvents () {
  for (const span of trace) {
    span.span_events = [
      { name: 'http.attempt', time_unix_nano: 1_415_926_535_897, attributes: { ...ATTR_TEMPLATE_HTTP_OK } },
      { name: 'http.failure', time_unix_nano: 1_415_926_535_898, attributes: { ...ATTR_TEMPLATE_HTTP_ERR } },
      { name: 'db.query', time_unix_nano: 1_415_926_535_899, attributes: { ...ATTR_TEMPLATE_DB } },
    ]
  }
}

const encoder = new AgentEncoder(writer)

// One pre-flight cycle to confirm encoder.encode actually advances state; catches a
// silent breakage where the fixture or loader skipped the encode path.
if (WITH_SPAN_EVENTS !== 'none') attachFreshEvents()
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
    attachFreshEvents()
    encoder.encode(trace)
  }
}
