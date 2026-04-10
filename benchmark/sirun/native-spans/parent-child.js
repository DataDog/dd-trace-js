'use strict'

// Parent-child span chain benchmark.
//
// Measures the cost of creating a chain of N nested spans, each with
// a few tags. This is the pattern seen in real instrumentation: a root
// web span spawns middleware spans, which spawn DB/HTTP client spans.
//
// Variants:
//   DEPTH=3   — root → parent → child (typical web request)
//   DEPTH=10  — deep chain (complex orchestration)

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

const ITERATIONS = 500_000
const depth = Number(process.env.DEPTH) || 3

const tagSets = [
  { 'span.type': 'web', 'http.method': 'GET', 'http.url': '/api/users' },
  { 'span.type': 'web', component: 'middleware', 'http.route': '/api/users/:id' },
  { 'span.type': 'sql', 'db.type': 'postgresql', 'db.statement': 'SELECT * FROM users WHERE id = $1' },
  { 'span.type': 'http', 'http.method': 'POST', 'http.url': 'https://auth.internal/verify' },
  { 'span.type': 'cache', 'cache.backend': 'redis', 'cache.command': 'GET' },
  { 'span.type': 'web', component: 'router', 'http.route': '/api/users/:id/profile' },
  { 'span.type': 'sql', 'db.type': 'postgresql', 'db.statement': 'SELECT * FROM profiles WHERE user_id = $1' },
  { 'span.type': 'http', 'http.method': 'GET', 'http.url': 'https://cdn.internal/avatar' },
  { 'span.type': 'cache', 'cache.backend': 'redis', 'cache.command': 'SET' },
  { 'span.type': 'web', component: 'serializer', 'content.type': 'application/json' },
]

for (let i = 0; i < ITERATIONS; i++) {
  const spans = new Array(depth)

  // Create the chain top-down
  for (let d = 0; d < depth; d++) {
    const opts = d === 0
      ? { tags: tagSets[d % tagSets.length] }
      : { childOf: spans[d - 1], tags: tagSets[d % tagSets.length] }
    spans[d] = tracer.startSpan(`span.depth.${d}`, opts)
  }

  // Finish bottom-up (realistic order)
  for (let d = depth - 1; d >= 0; d--) {
    spans[d].finish()
  }

  if (pendingNativeIds && pendingNativeIds.length >= DRAIN_THRESHOLD) drainNative()
}
drainNative()
