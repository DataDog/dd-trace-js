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

  it('preserves application headers and overrides matching propagation headers', () => {
    class Producer {
      produce (...args) {
        this.args = args
      }
    }

    const module = { Producer }
    HOOK(module)

    const injectTraceHeaders = (ctx) => {
      ctx.messages[0].headers = {
        'x-datadog-trace-id': '123',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      }
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
        { 'x-datadog-trace-id': 'old-trace-id' },
        { traceparent: '00-old-old-00' },
        { Traceparent: 'application-value' },
      ]
    )

    assert.deepStrictEqual(producer.args[6], [
      { 'content-type': 'text' },
      { Traceparent: 'application-value' },
      { 'x-datadog-trace-id': '123' },
      { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    ])
  })

  it('retains the existing replacement behavior for non-array headers', () => {
    const invalidHeaders = { 'content-type': 'text' }

    class Producer {
      produce (...args) {
        this.args = args
      }
    }

    const module = { Producer }
    HOOK(module)

    const injectTraceHeaders = (ctx) => {
      ctx.messages[0].headers = { 'x-datadog-trace-id': '123' }
    }
    subscriptions.push(injectTraceHeaders)
    producerStart.subscribe(injectTraceHeaders)

    const producer = new module.Producer()
    producer.produce('topic', null, Buffer.from('message'), 'key', Date.now(), undefined, invalidHeaders)

    assert.deepStrictEqual(producer.args[6], [{ 'x-datadog-trace-id': '123' }])
  })
})
