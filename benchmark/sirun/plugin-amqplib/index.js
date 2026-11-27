'use strict'

const assert = require('node:assert/strict')

const guard = require('../startup-guard')

const AmqplibConsumer = require('../../../packages/datadog-plugin-amqplib/src/consumer')
const AmqplibProducer = require('../../../packages/datadog-plugin-amqplib/src/producer')
const { DataStreamsManager } = require('../../../packages/dd-trace/src/datastreams/manager')
const { DsmPathwayCodec } = require('../../../packages/dd-trace/src/datastreams/pathway')

const { VARIANT = 'publish', OPERATIONS } = process.env
const operations = Number(OPERATIONS) || 2_000_000
const consume = VARIANT === 'consume'

const content = Buffer.from('{"event":"order_created","order_id":987654,"total":42.5}')
const pathway = {
  hash: Buffer.from('0123456789abcdef', 'hex'),
  pathwayStartNs: 1_716_950_000_000_000_000,
  edgeStartNs: 1_716_950_000_500_000_000,
}
const routes = [
  ['', 'callback-8f14e45f-ceea-467a-9f3a-6b1f1e2c0a11'],
  ['', 'orders'],
  ['inventory.events', 'inventory.updated'],
  ['', 'billing_updates'],
  ['', 'amq.gen-JzTY20BRgKO-HjmUJj0wLg'],
  ['commerce.events', 'orders.created'],
]
const fixtures = VARIANT === 'publish-churn'
  ? Array.from({ length: 4096 }, (_, index) => ['', 'callback-' + index.toString(16).padStart(32, '0')])
  : routes

let lastEdgeTags
let lastParentHash
const manager = new DataStreamsManager({
  /**
   * @param {string[]} edgeTags
   * @param {import('../../..').Span | null} _span
   * @param {{ hash: Buffer } | null} parent
   */
  setCheckpoint (edgeTags, _span, parent) {
    lastEdgeTags = edgeTags
    lastParentHash = parent?.hash
    return pathway
  },
})
const config = { enabled: true, dsmEnabled: true }
const Plugin = consume ? AmqplibConsumer : AmqplibProducer
const plugin = new Plugin(manager, config)
plugin.configure(config)

const fields = { exchange: '', routingKey: '', headers: {} }
const headers = { 'correlation-id': 'order-987654' }
DsmPathwayCodec.encode(pathway, headers)
const ctx = {
  currentStore: { span: null },
  fields,
  queue: '',
  message: consume ? { content, properties: { headers } } : content,
}

/**
 * @param {string[]} route Exchange and routing key from an AMQP message.
 */
function checkpoint (route) {
  const [exchange, routingKey] = route
  fields.exchange = exchange
  fields.routingKey = routingKey
  if (consume) {
    ctx.queue = routingKey
  } else {
    fields.headers = { 'correlation-id': 'order-987654' }
  }
  plugin.start(ctx)
}

checkpoint(fixtures[0])
assert.deepStrictEqual(lastEdgeTags, consume
  ? ['direction:in', 'topic:callback-*', 'type:rabbitmq']
  : ['direction:out', 'topic:callback-*', 'has_routing_key:true', 'type:rabbitmq'])
if (consume) {
  assert.deepStrictEqual(lastParentHash, pathway.hash)
} else {
  assert.ok(fields.headers['dd-pathway-ctx-base64'])
}
if (VARIANT === 'publish') {
  checkpoint(routes[2])
  assert.strictEqual(lastEdgeTags[1], 'exchange:inventory.events')
}

guard.loopStart()
for (let iteration = 0; iteration < operations; iteration++) {
  checkpoint(fixtures[iteration % fixtures.length])
}
guard.done()
