'use strict'

// Tag read benchmark.
//
// Measures the cost of reading tags back from a span. For JS spans this
// is a direct property lookup on a plain object. For native spans,
// getTag() reads from a JS-side cache (no WASM call), but getTags()
// returns a copy. This matters for instrumentation code that reads
// tags to make routing decisions.

const nock = require('nock')

nock.disableNetConnect()
nock('http://127.0.0.1:8126').persist().put(/.*/).reply(200, '{}').post(/.*/).reply(200, '{}')

const tracer = require('../../..').init({ hostname: '127.0.0.1', port: 8126 })

const nativeSpans = tracer._tracer._nativeSpans
const pendingNativeIds = nativeSpans ? [] : null

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

// Pre-create spans with tags, then measure read cost in a separate loop
// to isolate reads from writes.
const spans = new Array(1000)
for (let i = 0; i < spans.length; i++) {
  spans[i] = tracer.startSpan('bench.gettag', {
    tags: {
      'http.method': 'GET',
      'http.url': 'https://api.example.com/users/123',
      'http.status_code': 200,
      'service.name': 'my-service',
      'resource.name': 'GET /users/:id',
    },
  })
}

// Read tags in a tight loop across the pre-created spans
for (let i = 0; i < ITERATIONS; i++) {
  const span = spans[i % spans.length]
  const ctx = span.context()

  // Individual reads (common in plugin code)
  ctx.getTag('http.method')
  ctx.getTag('http.status_code')
  ctx.getTag('resource.name')
}

// Clean up
for (const span of spans) {
  span.finish()
}
drainNative()
