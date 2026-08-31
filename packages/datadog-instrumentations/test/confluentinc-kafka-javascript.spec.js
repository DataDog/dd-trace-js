'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, describe, it } = require('mocha')

require('../src/confluentinc-kafka-javascript')

const HOOK = globalThis[Symbol.for('_ddtrace_instrumentations')]['@confluentinc/kafka-javascript'][0].hook
const producerStart = dc.channel('apm:confluentinc-kafka-javascript:produce:start')
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

/** @typedef {Array<Record<string, string | Buffer>>} NativeHeaders */
/** @typedef {Record<string, string | Buffer | Array<string | Buffer>>} NativeHeaderCarrier */
/** @typedef {{ messages: Array<{ headers: NativeHeaderCarrier }> }} ProduceContext */

function stageProducer () {
  class Producer {
    /** @type {NativeHeaders} */
    forwardedHeaders = []

    produce (topic, partition, message, key, timestamp, opaque, headers) {
      this.forwardedHeaders = headers
    }
  }

  const module = { Producer }
  HOOK(module)
  return new module.Producer()
}

/**
 * @param {{ produce: Function, forwardedHeaders: NativeHeaders }} producer
 * @param {unknown} headers Seventh positional `produce()` argument.
 * @returns {NativeHeaders} What the boundary forwarded to the library.
 */
function produce (producer, headers) {
  producer.produce('topic', null, Buffer.from('message'), 'key', Date.now(), undefined, headers)
  return producer.forwardedHeaders
}

describe('packages/datadog-instrumentations/src/confluentinc-kafka-javascript.js', () => {
  const subscribers = []

  afterEach(() => {
    for (const subscriber of subscribers) {
      producerStart.unsubscribe(subscriber)
    }
    subscribers.length = 0
  })

  describe('native produce headers', () => {
    /**
     * @param {(ctx: ProduceContext) => void} subscriber
     */
    function trackSubscriber (subscriber) {
      subscribers.push(subscriber)
      producerStart.subscribe(subscriber)
    }

    /**
     * @param {ProduceContext} ctx
     */
    function injectPropagationHeaders (ctx) {
      ctx.messages[0].headers ??= {}
      ctx.messages[0].headers['x-datadog-trace-id'] = '123'
      ctx.messages[0].headers.traceparent = TRACEPARENT
    }

    it('keeps application entries and replaces only the keys propagation writes', () => {
      trackSubscriber(injectPropagationHeaders)

      const binary = Buffer.from([0xde, 0xad, 0xbe, 0xef])
      const applicationHeaders = [
        { 'content-type': 'text/plain' },
        { 'content-type': 'application/json' },
        { 'content-type': 'application/octet-stream' },
        { 'binary-header': binary },
        { traceparent: 'stale-traceparent' },
        { Traceparent: 'application-value' },
        { ['__proto__']: 'prototype-safe' },
      ]

      const produced = produce(stageProducer(), applicationHeaders)

      assert.deepStrictEqual(produced, [
        { 'content-type': 'text/plain' },
        { 'content-type': 'application/json' },
        { 'content-type': 'application/octet-stream' },
        { 'binary-header': binary },
        { Traceparent: 'application-value' },
        { ['__proto__']: 'prototype-safe' },
        { traceparent: TRACEPARENT },
        { 'x-datadog-trace-id': '123' },
      ])
      assert.strictEqual(produced[0], applicationHeaders[0])
      assert.strictEqual(produced[3]['binary-header'], binary)
    })

    it('merges entries the binding reads differently from their literal shape', () => {
      trackSubscriber(injectPropagationHeaders)

      const multiKey = { first: 'one', second: 'two' }
      const arrayEntry = ['array-value']
      const primitiveEntry = 'primitive-value'

      const produced = produce(stageProducer(), [multiKey, arrayEntry, primitiveEntry])

      assert.strictEqual(produced[0], multiKey)
      assert.strictEqual(produced[1], arrayEntry)
      assert.strictEqual(produced[2], primitiveEntry)
      assert.deepStrictEqual(produced.slice(3), [
        { 'x-datadog-trace-id': '123' },
        { traceparent: TRACEPARENT },
      ])
    })

    it('forwards the caller array whenever the binding has to reject it', () => {
      trackSubscriber(injectPropagationHeaders)

      const nonEnumerable = {}
      Object.defineProperty(nonEnumerable, 'hidden', { value: 'value' })

      const rejectedShapes = [
        [{ 'content-type': 'application/json' }, { 'content-length': 42 }],
        [{ 'content-type': 'application/json' }, nonEnumerable],
        [{}],
        [42],
      ]

      const producer = stageProducer()
      for (const [index, headers] of rejectedShapes.entries()) {
        assert.strictEqual(produce(producer, headers), headers, `rejected shape at index ${index}`)
      }
    })

    it('drops every application entry sharing a key propagation claims', () => {
      trackSubscriber(injectPropagationHeaders)

      const produced = produce(stageProducer(), [
        { traceparent: 'first-stale' },
        { traceparent: 'second-stale' },
      ])

      assert.deepStrictEqual(produced, [
        { traceparent: TRACEPARENT },
        { 'x-datadog-trace-id': '123' },
      ])
    })

    it('drops stale duplicates when propagation writes the same final value', () => {
      trackSubscriber(injectPropagationHeaders)

      const produced = produce(stageProducer(), [
        { traceparent: 'stale-traceparent' },
        { traceparent: TRACEPARENT },
      ])

      assert.deepStrictEqual(produced, [
        { traceparent: TRACEPARENT },
        { 'x-datadog-trace-id': '123' },
      ])
    })

    it('publishes one carrier holding every application value the caller sent', () => {
      /** @type {NativeHeaderCarrier[]} */
      const carriers = []
      trackSubscriber((ctx) => carriers.push(ctx.messages[0].headers))

      const binary = Buffer.from('binary-value')
      produce(stageProducer(), [
        { 'content-type': 'text' },
        { 'content-type': 'application/json' },
        { 'content-type': 'application/octet-stream' },
        { 'binary-header': binary },
      ])

      assert.strictEqual(carriers.length, 1)
      const [carrier] = carriers
      assert.deepStrictEqual(Object.keys(carrier), ['content-type', 'binary-header'])
      assert.deepStrictEqual(carrier['content-type'], ['text', 'application/json', 'application/octet-stream'])
      assert.strictEqual(carrier['binary-header'], binary)
    })

    it('sends generated headers only for shapes the binding cannot consume', () => {
      trackSubscriber(injectPropagationHeaders)

      const producer = stageProducer()
      const unusableShapes = [
        { 'content-type': 'text/plain' },
        'content-type: text/plain',
        [null],
        [undefined],
        [{ 'content-type': 'text/plain' }, null],
      ]

      for (const [index, headers] of unusableShapes.entries()) {
        assert.deepStrictEqual(produce(producer, headers), [
          { 'x-datadog-trace-id': '123' },
          { traceparent: TRACEPARENT },
        ], `unusable shape at index ${index}`)
      }
    })

    it('sends no headers when neither the caller nor propagation supplied any', () => {
      trackSubscriber(() => {})

      const producer = stageProducer()

      assert.deepStrictEqual(produce(producer, undefined), [])
      assert.deepStrictEqual(produce(producer, []), [])
    })

    it('forwards the caller argument untouched when no subscriber is attached', () => {
      const applicationHeaders = [{ 'content-type': 'application/json' }]

      assert.strictEqual(produce(stageProducer(), applicationHeaders), applicationHeaders)
    })
  })
})
