'use strict'

const tracer = require('dd-trace')

it('exports a span with a known trace and parent', () => {
  const parent = tracer.extract('text_map', {
    traceparent: '00-1234567890abcdeffedcba9876543210-abcdef0123456789-01',
  })
  const span = tracer.startSpan('mocha.worker.ids', { childOf: parent })
  span.setTag('ipc.transport', typeof process.send === 'function' ? 'fork' : 'main')
  span.setTag('ipc.span_id', span.context().toSpanId())
  span.finish()
})
