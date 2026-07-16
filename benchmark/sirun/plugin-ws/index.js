'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const WSProducerPlugin = require('../../../packages/datadog-plugin-ws/src/producer')
const WSReceiverPlugin = require('../../../packages/datadog-plugin-ws/src/receiver')
const DatadogSpanContext = require('../../../packages/dd-trace/src/opentracing/span_context')
const id = require('../../../packages/dd-trace/src/id')

const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

// Every traced websocket message walks the plugin's bindStart (split the resource
// path, build the meta literal, startSpan) and end (add the span link plus, when the
// handshake carried distributed context, the span-pointer hash). `send` drives the
// producer, `receive` the receiver. Subclass the real plugins and stub only the
// tracer-reaching hooks so the measured surface is the plugin's own per-message work
// rather than the bare util helpers; startSpan captures the meta it is handed so V8
// cannot elide bindStart's literal.
let lastMeta
let lastLink
const FAKE_SPAN = { addLink (link) { lastLink = link }, setTag () {}, finish () {} }
function benched (Base) {
  return class extends Base {
    addTraceSubs () { /* skip diagnostic-channel subscriptions */ }
    serviceName () { return 'ws-svc' }
    operationName () { return 'websocket' }
    startSpan (name, options) { lastMeta = options.meta; return FAKE_SPAN }
  }
}

const Base = VARIANT === 'receive' ? WSReceiverPlugin : WSProducerPlugin
const tracer = { _service: 'web-app' }
const plugin = new (benched(Base))(tracer, {})
plugin.configure({ enabled: true, traceWebsocketMessagesEnabled: true, service: 'ws-svc' })

// The handshake span context lives on the socket for the connection's lifetime and
// carries distributed context (a remote parent), so end() builds the span-pointer
// hash that dominates the per-message instrumentation cost.
const handshakeContext = new DatadogSpanContext({
  traceId: id('1234567890abcdef', 16),
  spanId: id('abcdef1234567890', 16),
  parentId: id('1111222233334444', 16),
})
handshakeContext._trace.tags['_dd.p.tid'] = '640cfd8d00000000'

const socket = {
  spanContext: handshakeContext,
  spanTags: { 'resource.name': 'websocket /v2/chat', 'service.name': 'ws-svc' },
  hasTraceHeaders: true,
}

// One per-message context, reused so the loop measures the plugin, not allocation.
const ctx = { byteLength: 128, socket, binary: false }

function messageOnce () {
  ctx.span = undefined
  lastLink = undefined
  plugin.bindStart(ctx)
  ctx.result = true
  plugin.end(ctx)
}

// Preflight: confirm the real plugin path built the span meta and a link carrying the
// span-pointer hash, so a refactor cannot silently turn the bench into a near no-op.
messageOnce()
assert.ok(lastMeta && lastMeta['resource.name'] === 'websocket /v2/chat',
  'bindStart did not build the span meta')
assert.ok(lastLink?.attributes['ptr.hash'], 'end did not build the span-pointer link')

guard.loopStart()
for (let i = 0; i < OPERATIONS; i++) {
  messageOnce()
}
guard.done()

assert.ok(lastMeta && lastLink, 'plugin hot path was never reached inside the loop')
