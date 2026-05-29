'use strict'

const assert = require('node:assert/strict')

const { DsmPathwayCodec, getMessageSize } = require('../../../packages/dd-trace/src/datastreams')

const { VARIANT } = process.env
const ITERATIONS = Number(process.env.ITERATIONS) || 8_000_000

// With Data Streams Monitoring enabled, every produced kafka message runs
// getMessageSize then DsmPathwayCodec.encode, which varint-encodes the pathway
// context into a reused scratch buffer and base64s it into the message headers.
// This is the per-message DSM hot path. The header trace-context injection is
// already covered by the propagation bench, so it is not duplicated here.
const dataStreamsContext = {
  hash: Buffer.from('0123456789abcdef', 'hex'),
  pathwayStartNs: 1_716_950_000_000_000_000,
  edgeStartNs: 1_716_950_000_500_000_000,
}

// Representative produced messages: a small JSON value with a key (the common
// case) and a larger value with a couple of user headers.
const SMALL = {
  key: 'user-1234567',
  value: '{"event":"order_created","order_id":987654,"total":42.5}',
  headers: {},
}
const LARGE = {
  key: 'session-abcdef0123456789',
  value: JSON.stringify({ event: 'page_view', path: '/api/v2/products', meta: 'x'.repeat(400) }),
  headers: { 'correlation-id': 'c-12345', source: 'web' },
}

const FIXTURES = {
  small: [SMALL],
  large: [LARGE],
  mixed: [SMALL, LARGE, SMALL],
}

const messages = FIXTURES[VARIANT]
assert.ok(messages, `unknown VARIANT: ${VARIANT}`)

// Fresh headers per message each iteration: encode writes a key into the carrier,
// matching the per-produce carrier the plugin hands it.
function encodeOnce (message) {
  const carrier = {}
  const size = getMessageSize(message)
  DsmPathwayCodec.encode(dataStreamsContext, carrier)
  return size + Object.keys(carrier).length
}

// Preflight: confirm encode actually wrote the pathway key.
const probe = {}
DsmPathwayCodec.encode(dataStreamsContext, probe)
assert.ok(Object.keys(probe).length === 1, 'DsmPathwayCodec.encode did not write the carrier')

let sink = 0
const len = messages.length
for (let i = 0; i < ITERATIONS; i++) {
  sink += encodeOnce(messages[i % len])
}

if (sink === 0) throw new Error('unreachable')
