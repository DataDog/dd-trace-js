'use strict'

// Span creation benchmark.
//
// Measures the full create-to-finish cycle with varying tag counts.
// The processor is short-circuited so export cost is excluded.
//
// Variants:
//   SCENARIO=bare      — create + finish, no tags
//   SCENARIO=10tags    — create with 10 realistic tags + finish

const tracer = require('../../..').init()

const nativeSpans = tracer._tracer._nativeSpans
const pendingNativeIds = nativeSpans ? [] : null
const DRAIN_THRESHOLD = 5000

tracer._tracer._processor.process = function (span) {
  if (pendingNativeIds) {
    pendingNativeIds.push(span.context()._slotIndex)
  }
  this._erase(span.context()._trace)
}

function drainNative () {
  if (!pendingNativeIds || pendingNativeIds.length === 0) return
  nativeSpans.flushChangeQueue()
  const buf = Buffer.alloc(pendingNativeIds.length * 4)
  let idx = 0
  for (const slot of pendingNativeIds) {
    buf.writeUInt32LE(slot, idx)
    idx += 4
  }
  nativeSpans._state.prepareChunk(pendingNativeIds.length, false, buf)
  nativeSpans.freeSlots(pendingNativeIds)
  pendingNativeIds.length = 0
}

const ITERATIONS = 1_000_000
const scenario = process.env.SCENARIO || 'bare'

if (scenario === 'bare') {
  for (let i = 0; i < ITERATIONS; i++) {
    tracer.startSpan('bench.create.bare').finish()
    if (pendingNativeIds && pendingNativeIds.length >= DRAIN_THRESHOLD) drainNative()
  }
} else if (scenario === '10tags') {
  for (let i = 0; i < ITERATIONS; i++) {
    const span = tracer.startSpan('bench.create.10tags', {
      tags: {
        'service.name': 'my-service',
        'resource.name': 'GET /users/123',
        'span.type': 'web',
        'http.method': 'GET',
        'http.url': 'https://api.example.com/users/123',
        'http.status_code': 200,
        'component': 'express',
        'custom.tag1': 'some-value',
        'custom.tag2': 42,
        'custom.tag3': 3.14159,
      },
    })
    span.finish()
    if (pendingNativeIds && pendingNativeIds.length >= DRAIN_THRESHOLD) drainNative()
  }
}
drainNative()
