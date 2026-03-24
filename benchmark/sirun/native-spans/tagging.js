'use strict'

// Span tagging benchmark.
//
// Isolates the cost of writing tags to an already-created span.
// For native spans this exercises queueOp + string table interning.
// For JS spans this is a plain property write.
//
// Variants:
//   SCENARIO=settag    — individual setTag() calls (string + numeric)
//   SCENARIO=addtags   — bulk addTags() with 5 tags per call

const tracer = require('../../..').init()

tracer._tracer._processor.process = function (span) {
  this._erase(span.context()._trace)
}

const ITERATIONS = 1_000_000
const scenario = process.env.SCENARIO || 'settag'

if (scenario === 'settag') {
  // Measure per-tag cost. Create spans in batches so the processor
  // doesn't accumulate unbounded traces.
  for (let i = 0; i < ITERATIONS; i++) {
    const span = tracer.startSpan('bench.settag')
    span.setTag('http.method', 'GET')
    span.setTag('http.url', 'https://api.example.com/users/123')
    span.setTag('http.status_code', 200)
    span.setTag('component', 'express')
    span.setTag('custom.metric', 42.5)
    span.finish()
  }
} else if (scenario === 'addtags') {
  for (let i = 0; i < ITERATIONS; i++) {
    const span = tracer.startSpan('bench.addtags')
    span.addTags({
      'http.method': 'POST',
      'http.url': 'https://api.example.com/orders',
      'http.status_code': 201,
      'component': 'express',
      'custom.metric': 99.9,
    })
    span.finish()
  }
}
