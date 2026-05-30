'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const {
  incrementWebSocketCounter,
  buildWebSocketSpanPointerHash,
  createWebSocketSpanContext,
  hasDistributedTracingContext,
} = require('../../../packages/datadog-plugin-ws/src/util')
const DatadogSpanContext = require('../../../packages/dd-trace/src/opentracing/span_context')
const id = require('../../../packages/dd-trace/src/id')

const { VARIANT } = process.env
const ITERATIONS = Number(process.env.ITERATIONS) || 6_000_000

// With websocket message tracing and distributed context, every traced message
// runs the span-pointer path: increment the per-socket counter, build the
// pointer hash (three bigint->hex conversions plus concat) and, for the link,
// a minimal span context. These are the per-message hot functions.
const handshakeContext = new DatadogSpanContext({
  traceId: id('1234567890abcdef', 16),
  spanId: id('abcdef1234567890', 16),
  parentId: id('1111222233334444', 16),
})
handshakeContext._trace.tags['_dd.p.tid'] = '640cfd8d00000000'

const socket = { hasTraceHeaders: true }
const traceIdBig = handshakeContext._traceId.toBigInt()
const spanIdBig = handshakeContext._spanId.toBigInt()

function pointerOnly () {
  const counter = incrementWebSocketCounter(socket, 'sendCounter')
  return buildWebSocketSpanPointerHash(traceIdBig, spanIdBig, counter, true, false).length
}

function pointerAndLink () {
  if (!hasDistributedTracingContext(handshakeContext, socket)) return 0
  const counter = incrementWebSocketCounter(socket, 'sendCounter')
  const hash = buildWebSocketSpanPointerHash(traceIdBig, spanIdBig, counter, true, false)
  const linkContext = createWebSocketSpanContext(handshakeContext)
  return hash.length + (linkContext ? 1 : 0)
}

const run = VARIANT === 'pointer-and-link' ? pointerAndLink : pointerOnly

// Preflight: confirm the hash is the documented fixed-width shape.
const sample = buildWebSocketSpanPointerHash(traceIdBig, spanIdBig, 1, true, false)
assert.equal(sample.length, 1 + 32 + 16 + 8, 'span pointer hash has unexpected width')

guard.loopStart()
let sink = 0
for (let i = 0; i < ITERATIONS; i++) {
  sink += run()
}
guard.done()

if (sink === 0) throw new Error('unreachable')
