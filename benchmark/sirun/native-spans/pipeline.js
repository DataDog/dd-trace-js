'use strict'

// Full pipeline benchmark (create → tag → finish → process).
//
// Unlike the other benchmarks, the processor is NOT short-circuited here.
// This measures the cost of SpanProcessor.process() — the critical
// difference being that JS mode calls spanFormat() for every span while
// native mode skips it entirely.
//
// The exporter's export() is replaced with a collector so we measure the
// process path without the real send; spans are periodically drained from
// native storage (extract + mocked-agent send) only to bound memory.

const nock = require('nock')

nock.disableNetConnect()
nock('http://127.0.0.1:8126').persist().put(/.*/).reply(200, '{}').post(/.*/).reply(200, '{}')

const tracer = require('../../..').init({
  hostname: '127.0.0.1',
  port: 8126,
})

const nativeSpans = tracer._tracer._nativeSpans
const pendingNativeIds = nativeSpans ? [] : null
const DRAIN_THRESHOLD = 5000

// Collect finished span ids; the actual drain happens in the (async) main loop
// so it can await the staging-clearing send.
tracer._tracer._exporter.export = function (spans) {
  if (pendingNativeIds) {
    for (const span of spans) {
      pendingNativeIds.push(span.context()._nativeSpanId)
    }
  }
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

const ITERATIONS = 200_000

async function main () {
  for (let i = 0; i < ITERATIONS; i++) {
    const root = tracer.startSpan('web.request', {
      tags: {
        'service.name': 'web-app',
        'resource.name': 'GET /api/users/123',
        'span.type': 'web',
        'http.method': 'GET',
        'http.url': 'https://api.example.com/users/123',
      },
    })

    const db = tracer.startSpan('postgresql.query', {
      childOf: root,
      tags: {
        'service.name': 'postgresql',
        'resource.name': 'SELECT * FROM users WHERE id = $1',
        'span.type': 'sql',
        'db.type': 'postgresql',
        'db.name': 'mydb',
      },
    })
    db.setTag('db.row_count', 1)
    db.finish()

    const cache = tracer.startSpan('redis.command', {
      childOf: root,
      tags: {
        'service.name': 'redis',
        'resource.name': 'GET',
        'span.type': 'cache',
        'cache.backend': 'redis',
      },
    })
    cache.setTag('cache.hit', true)
    cache.finish()

    root.setTag('http.status_code', 200)
    root.finish()

    if (pendingNativeIds && pendingNativeIds.length >= DRAIN_THRESHOLD) await drainNative()
  }
  await drainNative()
}

main()
