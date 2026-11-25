'use strict'

const tracer = require('dd-trace')
// Jest 24 only resolves the unprefixed built-in.
const { isMainThread } = require('worker_threads')

it('exports a span with a known trace and parent', () => {
  const parent = tracer.extract('text_map', {
    traceparent: '00-1234567890abcdeffedcba9876543210-abcdef0123456789-01',
  })
  const transport = isMainThread ? typeof process.send === 'function' ? 'fork' : 'main' : 'thread'
  const span = tracer.startSpan('jest.worker.ids', { childOf: parent })
  span.setTag('ipc.transport', transport)
  span.setTag('ipc.span_id', span.context().toSpanId())
  span.finish()
})
