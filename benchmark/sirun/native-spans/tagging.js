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

const nock = require('nock')

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

// Extract the accumulated spans (bounds the WASM map) and drain the staged
// chunk via a mocked-agent send (bounds prepared-chunk memory). Span ids are
// 8-byte u64 LE.
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
const scenario = process.env.SCENARIO || 'settag'

async function main () {
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
      if (pendingNativeIds && pendingNativeIds.length >= DRAIN_THRESHOLD) await drainNative()
    }
  } else if (scenario === 'addtags') {
    for (let i = 0; i < ITERATIONS; i++) {
      const span = tracer.startSpan('bench.addtags')
      span.addTags({
        'http.method': 'POST',
        'http.url': 'https://api.example.com/orders',
        'http.status_code': 201,
        component: 'express',
        'custom.metric': 99.9,
      })
      span.finish()
      if (pendingNativeIds && pendingNativeIds.length >= DRAIN_THRESHOLD) await drainNative()
    }
  }
  await drainNative()
}

main()
