'use strict'

// Span creation benchmark.
//
// Measures the full create-to-finish cycle with varying tag counts.
// The processor is short-circuited so export cost is excluded. Spans are
// periodically drained from native storage only to keep the WASM span map
// (and the staged-chunk buffer) bounded over the run — see drainNative.
//
// Variants:
//   SCENARIO=bare      — create + finish, no tags
//   SCENARIO=10tags    — create with 10 realistic tags + finish

const nock = require('nock')

// Mock the agent so the periodic drain's send resolves instantly and never
// touches the network (the drain exists only to bound memory, not to measure
// export).
nock.disableNetConnect()
nock('http://127.0.0.1:8126').persist().put(/.*/).reply(200, '{}').post(/.*/).reply(200, '{}')

const tracer = require('../../..').init({ hostname: '127.0.0.1', port: 8126 })

const nativeSpans = tracer._tracer._nativeSpans
const pendingNativeIds = nativeSpans ? [] : null
const DRAIN_THRESHOLD = 5000

tracer._tracer._processor.process = function (span) {
  if (pendingNativeIds) {
    pendingNativeIds.push(span.context()._nativeSpanId)
  }
  this._erase(span.context()._trace, [])
}

// Extract the accumulated spans from the WASM map (bounds the map) and send the
// staged chunk (bounds prepared-chunk memory — prepareChunk stages one chunk per
// call and only sendPreparedChunk drains the staging). Span ids are 8-byte u64
// LE, written straight into the flush buffer.
async function drainNative () {
  if (!pendingNativeIds || pendingNativeIds.length === 0) return
  nativeSpans.flushChangeQueue()
  const buf = Buffer.alloc(pendingNativeIds.length * 8)
  let idx = 0
  for (const spanId of pendingNativeIds) {
    buf.set(spanId, idx)
    idx += 8
  }
  nativeSpans._state.prepareChunk(pendingNativeIds.length, false, buf)
  await nativeSpans._state.sendPreparedChunk().catch(() => {})
  pendingNativeIds.length = 0
}

const ITERATIONS = 1_000_000
const scenario = process.env.SCENARIO || 'bare'

async function main () {
  if (scenario === 'bare') {
    for (let i = 0; i < ITERATIONS; i++) {
      tracer.startSpan('bench.create.bare').finish()
      if (pendingNativeIds && pendingNativeIds.length >= DRAIN_THRESHOLD) await drainNative()
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
          component: 'express',
          'custom.tag1': 'some-value',
          'custom.tag2': 42,
          'custom.tag3': 3.14159,
        },
      })
      span.finish()
      if (pendingNativeIds && pendingNativeIds.length >= DRAIN_THRESHOLD) await drainNative()
    }
  }
  await drainNative()
}

main()
