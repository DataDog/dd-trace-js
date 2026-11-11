'use strict'

const assert = require('node:assert/strict')

const { EventEmitter } = require('node:events')

const dc = require('dc-polyfill')
const { afterEach, describe, it } = require('mocha')

require('../src/confluentinc-kafka-javascript')

const HOOK = globalThis[Symbol.for('_ddtrace_instrumentations')]['@confluentinc/kafka-javascript'][0].hook
const producerStart = dc.channel('apm:confluentinc-kafka-javascript:produce:start')
const consumerStart = dc.channel('apm:confluentinc-kafka-javascript:consume:start')
// librdkafka error codes the KafkaJS-compatible API reports on `error.code`.
const ERR__STATE = -172
const ERR__TIMED_OUT = -185
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

  describe('cluster id', () => {
    /** @type {Array<{ channel: import('dc-polyfill').Channel, subscriber: (ctx: object) => void }>} */
    const clusterIdSubscribers = []

    afterEach(() => {
      for (const { channel, subscriber } of clusterIdSubscribers) {
        channel.unsubscribe(subscriber)
      }
      clusterIdSubscribers.length = 0
    })

    /**
     * @param {import('dc-polyfill').Channel} channel
     * @returns {Array<string | undefined>} The cluster id of every published context, in order.
     */
    function recordClusterIds (channel) {
      const clusterIds = []
      const subscriber = (ctx) => clusterIds.push((ctx.extractedArgs ?? ctx).clusterId)
      clusterIdSubscribers.push({ channel, subscriber })
      channel.subscribe(subscriber)
      return clusterIds
    }

    describe('KafkaJS-compatible API', () => {
      /**
       * @param {((options: { timeout: number }) => Promise<string>) | undefined} clusterId Stub of `clusterId()`;
       *   omitted before 1.11.0.
       * @param {() => Promise<unknown>} [connect]
       */
      function stageKafka (clusterId, connect = async () => 'connected') {
        class Client {
          connected = false

          async connect () {
            const value = await connect()
            this.connected = true
            return value
          }

          /**
           * @param {{ topic: string, messages: object[] }} payload
           */
          async send (payload) {
            return payload.messages.map(() => ({ topicName: payload.topic, partition: 0, baseOffset: '0' }))
          }

          async run ({ eachMessage }) {
            await eachMessage({ topic: 'topic', partition: 0, message: { offset: '1', headers: {} } })
          }
        }
        if (clusterId) Client.prototype.clusterId = clusterId

        class Kafka {
          producer () {
            return new Client()
          }

          /**
           * @param {object} config
           */
          consumer (config) {
            return new Client()
          }
        }

        const module = { KafkaJS: { Kafka } }
        HOOK(module)
        return new module.KafkaJS.Kafka()
      }

      it('reads the cluster id once while connecting a producer', async () => {
        const clusterIds = recordClusterIds(producerStart)
        const lookups = []
        const producer = stageKafka(async function (options) {
          lookups.push(options)
          return 'cluster-1'
        }).producer()

        await producer.connect()
        await producer.send({ topic: 'topic', messages: [{ value: 'a' }] })
        await producer.send({ topic: 'topic', messages: [{ value: 'b' }] })

        assert.deepStrictEqual(clusterIds, ['cluster-1', 'cluster-1'])
        assert.deepStrictEqual(lookups, [{ timeout: 0 }])
      })

      it('reports the cluster id on consumed messages', async () => {
        const clusterIds = recordClusterIds(consumerStart)
        const consumer = stageKafka(async () => 'cluster-1').consumer({ kafkaJS: { groupId: 'group' } })

        await consumer.connect()
        await consumer.run({ eachMessage: async () => {} })

        assert.deepStrictEqual(clusterIds, ['cluster-1'])
      })

      it('retries a lookup made before the client was connected', async () => {
        const clusterIds = recordClusterIds(producerStart)
        let lookups = 0
        const producer = stageKafka(async function () {
          lookups++
          if (!this.connected) throw Object.assign(new Error('not connected'), { code: ERR__STATE })
          return 'cluster-1'
        }).producer()

        await producer.send({ topic: 'topic', messages: [{ value: 'a' }] })
        await producer.connect()
        await producer.send({ topic: 'topic', messages: [{ value: 'b' }] })

        assert.deepStrictEqual(clusterIds, [undefined, 'cluster-1'])
        assert.strictEqual(lookups, 2)
      })

      it('keeps any other lookup failure without retrying', async () => {
        const clusterIds = recordClusterIds(producerStart)
        let lookups = 0
        const producer = stageKafka(async () => {
          lookups++
          throw Object.assign(new Error('Cluster id is not available'), { code: ERR__TIMED_OUT })
        }).producer()

        await producer.connect()
        await producer.send({ topic: 'topic', messages: [{ value: 'a' }] })
        await producer.send({ topic: 'topic', messages: [{ value: 'b' }] })

        assert.deepStrictEqual(clusterIds, [undefined, undefined])
        assert.strictEqual(lookups, 1)
      })

      it('resolves connect() with the value of the library', async () => {
        recordClusterIds(producerStart)
        const producer = stageKafka(async () => 'cluster-1').producer()

        assert.strictEqual(await producer.connect(), 'connected')
      })

      it('rejects connect() with the error of the library and looks nothing up', async () => {
        recordClusterIds(producerStart)
        const error = new Error('connection refused')
        let lookups = 0
        const producer = stageKafka(async () => {
          lookups++
          return 'cluster-1'
        }, async () => { throw error }).producer()

        await assert.rejects(producer.connect(), (rejection) => rejection === error)
        assert.strictEqual(lookups, 0)
      })

      it('reports no cluster id for releases without clusterId()', async () => {
        const clusterIds = recordClusterIds(producerStart)
        const producer = stageKafka(undefined).producer()

        assert.strictEqual(await producer.connect(), 'connected')
        await producer.send({ topic: 'topic', messages: [{ value: 'a' }] })

        assert.deepStrictEqual(clusterIds, [undefined])
      })
    })

    describe('node-rdkafka API', () => {
      /**
       * @param {((timeout: number, callback: Function) => void) | undefined} clusterId Stub of `clusterId()`.
       */
      function stageNativeProducer (clusterId) {
        class Producer extends EventEmitter {
          isConnectedValue = false

          isConnected () {
            return this.isConnectedValue
          }

          produce () {}
        }
        if (clusterId) Producer.prototype.clusterId = clusterId

        const module = { Producer }
        HOOK(module)
        return new module.Producer()
      }

      /**
       * @param {{ produce: Function }} producer
       */
      function produceMessage (producer) {
        producer.produce('topic', null, Buffer.from('message'), 'key')
      }

      it('starts the lookup when the client is ready', () => {
        const clusterIds = recordClusterIds(producerStart)
        const timeouts = []
        const producer = stageNativeProducer(function (timeout, callback) {
          timeouts.push(timeout)
          callback(null, 'cluster-1')
        })

        producer.isConnectedValue = true
        producer.emit('ready')
        assert.deepStrictEqual(timeouts, [0])

        produceMessage(producer)
        produceMessage(producer)

        assert.deepStrictEqual(clusterIds, ['cluster-1', 'cluster-1'])
        assert.deepStrictEqual(timeouts, [0])
      })

      it('starts the lookup on the first produce of a connected client', () => {
        const clusterIds = recordClusterIds(producerStart)
        const producer = stageNativeProducer((timeout, callback) => callback(null, 'cluster-1'))

        produceMessage(producer)
        producer.isConnectedValue = true
        produceMessage(producer)

        assert.deepStrictEqual(clusterIds, [undefined, 'cluster-1'])
      })

      it('reports no cluster id for releases without clusterId()', () => {
        const clusterIds = recordClusterIds(producerStart)
        const producer = stageNativeProducer(undefined)

        producer.isConnectedValue = true
        producer.emit('ready')
        produceMessage(producer)

        assert.deepStrictEqual(clusterIds, [undefined])
      })
    })
  })
})
