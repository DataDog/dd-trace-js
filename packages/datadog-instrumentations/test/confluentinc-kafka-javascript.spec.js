'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, describe, it } = require('mocha')

require('../src/confluentinc-kafka-javascript')

const HOOK = globalThis[Symbol.for('_ddtrace_instrumentations')]['@confluentinc/kafka-javascript'][0].hook
const producerStart = dc.channel('apm:confluentinc-kafka-javascript:produce:start')

describe('packages/datadog-instrumentations/src/confluentinc-kafka-javascript.js', () => {
  const subscriptions = []

  afterEach(() => {
    for (const subscription of subscriptions) {
      producerStart.unsubscribe(subscription)
    }
    subscriptions.length = 0
  })

  it('normalizes native headers before tracing and preserves Buffer values', () => {
    class Producer {
      produce (...args) {
        this.args = args
      }
    }

    const module = { Producer }
    HOOK(module)

    const injectTraceHeaders = (ctx) => {
      ctx.messages[0].headers['x-datadog-trace-id'] = '123'
      ctx.messages[0].headers.traceparent =
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    }
    subscriptions.push(injectTraceHeaders)
    producerStart.subscribe(injectTraceHeaders)

    const producer = new module.Producer()
    producer.produce(
      'topic',
      null,
      Buffer.from('message'),
      'key',
      Date.now(),
      undefined,
      [
        { 'content-type': 'text' },
        { 'content-type': 'application/json' },
        { 'binary-header': Buffer.from([0xde, 0xad, 0xbe, 0xef]) },
        { 'x-datadog-trace-id': 'old-trace-id' },
        { traceparent: '00-old-old-00' },
        { Traceparent: 'application-value' },
        { ['__proto__']: 'prototype-safe' },
      ]
    )

    const producedHeaders = producer.args[6]
    const producedCarrier = headersToObject(producedHeaders)

    assert.strictEqual(producedHeaders.filter(header => Object.hasOwn(header, 'content-type')).length, 1)
    assert.strictEqual(producedCarrier['content-type'], 'application/json')
    assert.strictEqual(producedCarrier.Traceparent, 'application-value')
    assert.strictEqual(producedCarrier['x-datadog-trace-id'], '123')
    assert.strictEqual(
      producedCarrier.traceparent,
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    )
    assert.ok(Buffer.isBuffer(producedCarrier['binary-header']))
    assert.deepStrictEqual(producedCarrier['binary-header'], Buffer.from([0xde, 0xad, 0xbe, 0xef]))
    assert.ok(Object.hasOwn(producedCarrier, '__proto__'))
    assert.strictEqual(Object.getOwnPropertyDescriptor(producedCarrier, '__proto__').value, 'prototype-safe')
  })

  it('returns generated headers only when native headers are malformed', () => {
    class Producer {
      produce (...args) {
        this.args = args
      }
    }

    const module = { Producer }
    HOOK(module)

    const injectTraceHeaders = (ctx) => {
      ctx.messages[0].headers['x-datadog-trace-id'] = '123'
    }
    subscriptions.push(injectTraceHeaders)
    producerStart.subscribe(injectTraceHeaders)

    const producer = new module.Producer()
    const malformedHeaders = [
      { 'content-type': 'text' },
      [null],
      [{ 'content-type': 'text' }, null],
      [{}],
      [{ first: 'one', second: 'two' }],
      [{ 'content-type': 42 }],
    ]

    for (const headers of malformedHeaders) {
      producer.produce('topic', null, Buffer.from('message'), 'key', Date.now(), undefined, headers)
      assert.deepStrictEqual(producer.args[6], [{ 'x-datadog-trace-id': '123' }])
    }
  })
})

function headersToObject (headers) {
  const carrier = Object.create(null)
  for (const header of headers) {
    if (!header || typeof header !== 'object') continue
    for (const key of Object.keys(header)) {
      carrier[key] = header[key]
    }
  }
  return carrier
}
