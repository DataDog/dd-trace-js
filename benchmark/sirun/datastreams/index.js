'use strict'

const assert = require('node:assert/strict')

// `DataStreamsProcessor` registers a `beforeExit` handler on the dd-trace global,
// which the tracer normally provides at init. Stub the minimal shape so the bench
// exercises the processor without a full tracer.
globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

const { DataStreamsProcessor } = require('../../../packages/dd-trace/src/datastreams/processor')
const { DsmPathwayCodec } = require('../../../packages/dd-trace/src/datastreams/pathway')
const { getMessageSize } = require('../../../packages/dd-trace/src/datastreams/size')

const { VARIANT } = process.env

const ITERATIONS = 1_200_000

const processor = new DataStreamsProcessor({
  dsmEnabled: true,
  service: 'bench-svc',
  env: 'bench-env',
  flushInterval: 2_147_483_647,
})
processor.writer.flush = () => {}
clearInterval(processor.timer)

const span = { setTag () {} }

const PRODUCER_TAGS = [
  ['direction:out', 'topic:orders', 'type:kafka'],
  ['direction:out', 'topic:payments', 'type:kafka'],
  ['direction:out', 'topic:notifications', 'type:kafka'],
  ['direction:out', 'topic:audit', 'type:kafka'],
  ['direction:out', 'topic:metrics', 'type:kafka'],
]

const CONSUMER_TAGS = [
  ['direction:in', 'topic:orders', 'type:kafka', 'group:fraud-svc'],
  ['direction:in', 'topic:payments', 'type:kafka', 'group:ledger-svc'],
  ['direction:in', 'topic:notifications', 'type:kafka', 'group:email-svc'],
  ['direction:in', 'topic:audit', 'type:kafka', 'group:storage-svc'],
  ['direction:in', 'topic:metrics', 'type:kafka', 'group:dashboard-svc'],
]

// `manual_checkpoint:true` is what `DataStreamsCheckpointer.setProduceCheckpoint` /
// `setConsumeCheckpoint` always set on the public manual-DSM API.
const MANUAL_PRODUCER_TAGS = PRODUCER_TAGS.map(tags => [...tags, 'manual_checkpoint:true'])

// Models a realistic mid-fanout customer (20 topics x 10 partitions per service); 200
// combos fit inside the LRU's 500-entry ceiling so steady-state every call is a hit.
const HIGH_CARDINALITY_PRODUCER_TAGS = []
for (let topicIndex = 0; topicIndex < 20; topicIndex++) {
  for (let partitionIndex = 0; partitionIndex < 10; partitionIndex++) {
    HIGH_CARDINALITY_PRODUCER_TAGS.push([
      'direction:out',
      `topic:orders-${topicIndex}`,
      `partition:${partitionIndex}`,
      'type:kafka',
    ])
  }
}

const MESSAGE = {
  key: 'order-1234567890',
  value: JSON.stringify({
    id: 'order-1234567890',
    customerId: 'cust-987654321',
    items: 5,
    total: 1234.56,
    currency: 'USD',
    placedAt: '2026-04-30T13:45:00Z',
  }),
  headers: {
    'x-traceparent': '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01',
    'x-request-id': 'req-deadbeefcafef00d',
    'x-tenant-id': 'tenant-a1b2c3d4e5f6',
  },
}
const MESSAGE_SIZE = getMessageSize(MESSAGE)

// Pre-warmed parent contexts so the LRU pathway cache reaches a realistic steady state.
const PARENT_CTXS = []
for (let parentIndex = 0; parentIndex < 10; parentIndex++) {
  PARENT_CTXS.push(processor.setCheckpoint(['direction:in', 'topic:warmup', `idx:${parentIndex}`], span, null, 0))
}

// Carriers cycle through the consume loop so the parent hash varies as it would when
// consuming from a producer that fans out across topics.
const CONSUME_CARRIERS = []
for (let carrierIndex = 0; carrierIndex < 50; carrierIndex++) {
  const ctx = processor.setCheckpoint(
    PRODUCER_TAGS[carrierIndex % PRODUCER_TAGS.length],
    span,
    PARENT_CTXS[carrierIndex % PARENT_CTXS.length],
    MESSAGE_SIZE
  )
  const carrier = {}
  DsmPathwayCodec.encode(ctx, carrier)
  CONSUME_CARRIERS.push(carrier)
}

// Pre-flight: confirm checkpoint + codec actually populate state; catches a silent
// breakage where the processor stayed disabled or the codec wrote no header.
assert.ok(processor.buckets.size > 0, 'no DSM bucket created')
assert.ok(CONSUME_CARRIERS[0]['dd-pathway-ctx-base64'], 'codec did not inject pathway header')

if (VARIANT === 'consume') {
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const carrier = CONSUME_CARRIERS[iteration % CONSUME_CARRIERS.length]
    const ctx = DsmPathwayCodec.decode(carrier)
    processor.setCheckpoint(CONSUMER_TAGS[iteration % CONSUMER_TAGS.length], span, ctx, MESSAGE_SIZE)
  }
} else if (VARIANT === 'produce-with-message-size') {
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const payloadSize = getMessageSize(MESSAGE)
    const ctx = processor.setCheckpoint(
      PRODUCER_TAGS[iteration % PRODUCER_TAGS.length],
      span,
      PARENT_CTXS[iteration % PARENT_CTXS.length],
      payloadSize
    )
    DsmPathwayCodec.encode(ctx, {})
  }
} else if (VARIANT === 'produce-manual-checkpoint') {
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const ctx = processor.setCheckpoint(
      MANUAL_PRODUCER_TAGS[iteration % MANUAL_PRODUCER_TAGS.length],
      span,
      PARENT_CTXS[iteration % PARENT_CTXS.length],
      MESSAGE_SIZE
    )
    DsmPathwayCodec.encode(ctx, {})
  }
} else if (VARIANT === 'produce-high-cardinality') {
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const ctx = processor.setCheckpoint(
      HIGH_CARDINALITY_PRODUCER_TAGS[iteration % HIGH_CARDINALITY_PRODUCER_TAGS.length],
      span,
      PARENT_CTXS[iteration % PARENT_CTXS.length],
      MESSAGE_SIZE
    )
    DsmPathwayCodec.encode(ctx, {})
  }
} else {
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const ctx = processor.setCheckpoint(
      PRODUCER_TAGS[iteration % PRODUCER_TAGS.length],
      span,
      PARENT_CTXS[iteration % PARENT_CTXS.length],
      MESSAGE_SIZE
    )
    DsmPathwayCodec.encode(ctx, {})
  }
}
