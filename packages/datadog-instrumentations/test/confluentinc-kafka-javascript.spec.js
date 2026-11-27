'use strict'

const assert = require('node:assert/strict')

const { EventEmitter } = require('node:events')

const dc = require('dc-polyfill')
const { afterEach, describe, it } = require('mocha')

require('../src/confluentinc-kafka-javascript')

const hooks = globalThis[Symbol.for('_ddtrace_instrumentations')]['@confluentinc/kafka-javascript']
const HOOK = hooks[0].hook
const CLUSTER_ID_HOOK = hooks.find(({ file }) => file === 'lib/client.js').hook
const producerStart = dc.channel('apm:confluentinc-kafka-javascript:produce:start')
const consumerStart = dc.channel('apm:confluentinc-kafka-javascript:consume:start')
const batchConsumerStart = dc.channel('apm:confluentinc-kafka-javascript:consume-batch:start')
const consumerCommit = dc.channel('apm:confluentinc-kafka-javascript:consume:commit')
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

    function recordCommits () {
      const commits = []
      const subscriber = (offsets) => commits.push(offsets)
      clusterIdSubscribers.push({ channel: consumerCommit, subscriber })
      consumerCommit.subscribe(subscriber)
      return commits
    }

    describe('KafkaJS-compatible API', () => {
      /**
       * @param {((options: { timeout: number }) => Promise<string>) | undefined} clusterId Stub of `clusterId()`;
       *   omitted before 1.11.0.
       * @param {() => Promise<unknown>} [connect]
       * @param {object} [options] `Kafka` constructor options.
       */
      function stageKafka (clusterId, connect = async () => 'connected', options = undefined) {
        class Client {
          connected = false
          offset = '1'
          globalConfig = undefined

          _getInternalClient () {
            return this.connected ? this : null
          }

          isConnected () {
            return this.connected
          }

          async connect () {
            const value = await connect()
            this.connected = true
            return value
          }

          /**
           * @param {{ topic: string, messages: object[] }} payload
           */
          async send (payload) {
            if (!this.connected) throw new Error('Producer is not connected')
            return payload.messages.map(() => ({ topicName: payload.topic, partition: 0, baseOffset: '0' }))
          }

          /**
           * @param {{ eachMessage?: Function, eachBatch?: Function }} options
           */
          async run (options) {
            this.runOptions = { ...options }
            const { eachMessage, eachBatch } = this.runOptions
            const message = { offset: this.offset, headers: {} }
            if (eachMessage) {
              await eachMessage({ topic: 'topic', partition: 0, message })
            } else if (eachBatch) {
              await eachBatch({ batch: { topic: 'topic', partition: 0, messages: [message] } })
            }
          }

          async commitOffsets () {}
        }
        if (clusterId) Client.prototype.clusterId = clusterId

        class Kafka {
          /**
           * @param {object} [options]
           */
          constructor (options) {
            this.options = options
          }

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
        return new module.KafkaJS.Kafka(options)
      }

      it('does not request the cluster id on connect or send', async () => {
        const clusterIds = recordClusterIds(producerStart)
        const lookups = []
        const producer = stageKafka(async function (options) {
          lookups.push(options)
          return 'cluster-1'
        }).producer()

        await producer.connect()
        await producer.send({ topic: 'topic', messages: [{ value: 'a' }] })
        await producer.send({ topic: 'topic', messages: [{ value: 'b' }] })

        assert.deepStrictEqual(lookups, [])
        assert.deepStrictEqual(clusterIds, [undefined, undefined])
      })

      it('does not request the cluster id on consumer connect or run', async () => {
        const clusterIds = recordClusterIds(consumerStart)
        const lookups = []
        const consumer = stageKafka(async options => {
          lookups.push(options)
          return 'cluster-1'
        }).consumer({ kafkaJS: { groupId: 'group' } })

        await consumer.connect()
        await consumer.run({ eachMessage: async () => {} })

        assert.deepStrictEqual(lookups, [])
        assert.deepStrictEqual(clusterIds, [undefined])
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

      for (const callbackName of ['eachMessage', 'eachBatch']) {
        it(`isolates offsets when consumers reuse ${callbackName} options`, async () => {
          recordClusterIds(consumerStart)
          recordClusterIds(batchConsumerStart)
          const commits = recordCommits()
          const kafka = stageKafka(async () => 'cluster-1')
          const first = kafka.consumer({ kafkaJS: { groupId: 'first' } })
          const second = kafka.consumer({ kafkaJS: { groupId: 'second' } })
          const callback = async () => {}
          const options = { [callbackName]: callback }
          second.offset = '2'
          await Promise.all([first.connect(), second.connect()])

          await first.run(options)
          await second.run(options)
          await first.commitOffsets()
          await second.commitOffsets()

          assert.strictEqual(options[callbackName], callback)
          assert.deepStrictEqual(commits, [
            [{ topic: 'topic', partition: 0, offset: '1', groupId: 'first', clusterId: undefined }],
            [{ topic: 'topic', partition: 0, offset: '2', groupId: 'second', clusterId: undefined }],
          ])
        })
      }

      it('preserves changes that run option getters make on the original options object', async () => {
        recordClusterIds(consumerStart)
        const clusterIds = recordClusterIds(batchConsumerStart)
        const consumer = stageKafka(async () => 'cluster-1').consumer({ kafkaJS: { groupId: 'group' } })
        const options = {
          get eachMessage () {
            assert.strictEqual(this, options)
            return undefined
          },
          get partitionsConsumedConcurrently () {
            assert.strictEqual(this, options)
            this.eachBatchAutoResolve = false
            return 1
          },
          eachBatchAutoResolve: true,
          eachBatch: async () => {},
        }

        await consumer.connect()
        await consumer.run(options)

        assert.strictEqual(consumer.runOptions.eachBatchAutoResolve, false)
        assert.deepStrictEqual(clusterIds, [undefined])
      })

      it('forwards run options with no enumerable callback', async () => {
        const clusterIds = recordClusterIds(consumerStart)
        const consumer = stageKafka(async () => 'cluster-1').consumer({ kafkaJS: { groupId: 'group' } })
        const options = Object.defineProperty({}, 'eachMessage', { value: async () => {} })

        await consumer.connect()
        await consumer.run(options)

        assert.deepStrictEqual(clusterIds, [])
      })

      it('reports the producer bootstrap servers finalized by Confluent', async () => {
        const servers = []
        const subscriber = (ctx) => servers.push(ctx.bootstrapServers)
        clusterIdSubscribers.push({ channel: producerStart, subscriber })
        producerStart.subscribe(subscriber)
        const producer = stageKafka(undefined, undefined, {
          kafkaJS: { brokers: ['bootstrap:9092'] },
          'metadata.broker.list': 'removed-by-builder:9092',
        }).producer()
        producer.globalConfig = { 'bootstrap.servers': 'bootstrap:9092' }

        await assert.rejects(producer.send({ topic: 'topic', messages: [{ value: 'early' }] }), {
          message: 'Producer is not connected',
        })
        await producer.connect()
        await producer.send({ topic: 'topic', messages: [{ value: 'a' }] })
        await producer.send({ topic: 'topic', messages: [{ value: 'b' }] })

        assert.deepStrictEqual(servers, [undefined, 'bootstrap:9092', 'bootstrap:9092'])
      })

      it('reports no bootstrap servers without the native client accessor', async () => {
        const servers = []
        const subscriber = (ctx) => servers.push(ctx.bootstrapServers)
        clusterIdSubscribers.push({ channel: producerStart, subscriber })
        producerStart.subscribe(subscriber)
        const producer = stageKafka(undefined).producer()
        producer._getInternalClient = undefined

        await producer.connect()
        await producer.send({ topic: 'topic', messages: [{ value: 'a' }] })

        assert.deepStrictEqual(servers, [undefined])
      })

      it('uses the native producer installed by a successful connection retry', async () => {
        class NativeProducer {
          metrics = {}

          /**
           * @param {string} servers
           */
          constructor (servers) {
            this.globalConfig = { 'bootstrap.servers': servers }
          }

          isConnected () {
            return true
          }

          /**
           * @param {number} timeout
           * @param {(error: Error | null, clusterId: string) => void} callback
           */
          clusterId (timeout, callback) {
            callback(null, 'cluster-retry')
          }
        }

        CLUSTER_ID_HOOK(NativeProducer)
        const observed = []
        const subscriber = ({ bootstrapServers, clusterId }) => observed.push({ bootstrapServers, clusterId })
        clusterIdSubscribers.push({ channel: producerStart, subscriber })
        producerStart.subscribe(subscriber)
        const producer = stageKafka(undefined).producer()
        let native = new NativeProducer('first:9092')
        producer._getInternalClient = () => native

        const message = { topic: 'topic', messages: [{ value: 'message' }] }
        await assert.rejects(producer.send(message), { message: 'Producer is not connected' })

        native = new NativeProducer('retry:9092')
        await producer.connect()
        native.clusterId(25, () => {})
        await producer.send(message)
        await producer.send(message)

        assert.deepStrictEqual(observed, [
          { bootstrapServers: 'first:9092', clusterId: undefined },
          { bootstrapServers: 'retry:9092', clusterId: 'cluster-retry' },
          { bootstrapServers: 'retry:9092', clusterId: 'cluster-retry' },
        ])
      })

      for (const [callbackName, start] of [['eachMessage', consumerStart], ['eachBatch', batchConsumerStart]]) {
        it(`reports the finalized bootstrap servers and cluster id with ${callbackName}`, async () => {
          recordClusterIds(consumerStart)
          const payloads = []
          const subscriber = (ctx) => payloads.push(ctx.extractedArgs)
          clusterIdSubscribers.push({ channel: start, subscriber })
          start.subscribe(subscriber)
          const consumer = stageKafka(async () => 'cluster-1', undefined, {
            kafkaJS: { brokers: ['constructor:9092'] },
          }).consumer({ kafkaJS: { groupId: 'group' } })
          consumer.globalConfig = { 'metadata.broker.list': 'finalized:9092' }

          await consumer.connect()
          await consumer.run({ [callbackName]: async () => {} })

          assert.deepStrictEqual(payloads.map(({ topic, bootstrapServers, clusterId, groupId }) => ({
            topic, bootstrapServers, clusterId, groupId,
          })), [{ topic: 'topic', bootstrapServers: 'finalized:9092', clusterId: undefined, groupId: 'group' }])
        })
      }
    })

    describe('node-rdkafka API', () => {
      /**
       * @param {((timeout: number, callback: Function) => void) | undefined} clusterId Stub of `clusterId()`.
       * @param {Record<string, string>} [config]
       */
      function stageNativeProducer (clusterId, config = undefined) {
        class Producer extends EventEmitter {
          isConnectedValue = false
          metrics = {}
          globalConfig = config

          isConnected () {
            return this.isConnectedValue
          }

          produce () {}
        }
        if (clusterId) Producer.prototype.clusterId = clusterId
        CLUSTER_ID_HOOK(Producer)

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

      it('does not request the cluster id on ready or produce', () => {
        const clusterIds = recordClusterIds(producerStart)
        const timeouts = []
        const producer = stageNativeProducer(function (timeout, callback) {
          timeouts.push(timeout)
          callback(null, 'cluster-1')
        })

        producer.isConnectedValue = true
        producer.emit('ready')

        produceMessage(producer)
        produceMessage(producer)

        assert.deepStrictEqual(timeouts, [])
        assert.deepStrictEqual(clusterIds, [undefined, undefined])
      })

      it('observes a successful application lookup and preserves its callback', () => {
        const clusterIds = recordClusterIds(producerStart)
        const receiver = {}
        const returnValue = {}
        const producer = stageNativeProducer(function (timeout, callback) {
          assert.strictEqual(this, producer)
          assert.strictEqual(timeout, 25)
          assert.strictEqual(callback.call(receiver, null, 'cluster-1'), returnValue)
          return this
        })

        produceMessage(producer)
        producer.isConnectedValue = true
        assert.strictEqual(producer.clusterId(25, function (error, clusterId) {
          assert.strictEqual(this, receiver)
          assert.strictEqual(error, null)
          assert.strictEqual(clusterId, 'cluster-1')
          return returnValue
        }), producer)
        produceMessage(producer)

        assert.deepStrictEqual(clusterIds, [undefined, 'cluster-1'])
      })

      it('ignores a lookup from an earlier connection after reconnecting', () => {
        const clusterIds = recordClusterIds(producerStart)
        const lookups = []
        const producer = stageNativeProducer((timeout, callback) => lookups.push(callback))

        producer.isConnectedValue = true
        producer.clusterId(25, () => {})
        producer.isConnectedValue = false
        producer.metrics = {}
        producer.emit('disconnected')
        producer.isConnectedValue = true
        producer.clusterId(25, () => {})

        assert.strictEqual(lookups.length, 2)
        lookups[0](null, 'cluster-1')
        produceMessage(producer)
        lookups[1](null, 'cluster-2')
        produceMessage(producer)

        assert.deepStrictEqual(clusterIds, [undefined, 'cluster-2'])
      })

      it('forwards errors from an application lookup', () => {
        const clusterIds = recordClusterIds(producerStart)
        const error = new Error('lookup failed')
        const producer = stageNativeProducer((timeout, callback) => callback(error))

        producer.isConnectedValue = true
        producer.clusterId(25, (received) => assert.strictEqual(received, error))
        produceMessage(producer)

        assert.deepStrictEqual(clusterIds, [undefined])
      })

      it('forwards an omitted callback to the SDK', () => {
        recordClusterIds(producerStart)
        const producer = stageNativeProducer(function (timeout) {
          assert.strictEqual(timeout, 25)
          assert.strictEqual(arguments.length, 1)
          return this
        })
        assert.strictEqual(producer.clusterId(25), producer)
      })

      it('does not read results before the connection finishes', () => {
        const clusterIds = recordClusterIds(producerStart)
        const producer = stageNativeProducer((timeout, callback) => callback(null, 'cluster-1'))
        producer.isConnectedValue = true
        producer._isConnecting = true
        producer.clusterId(25, () => {})
        producer._isConnecting = false
        produceMessage(producer)

        assert.deepStrictEqual(clusterIds, [undefined])
      })

      it('does not retain results without subscribers or connection metrics', () => {
        const producer = stageNativeProducer((timeout, callback) => callback(null, 'cluster-1'))
        producer.isConnectedValue = true
        producer.clusterId(25, () => {})
        const clusterIds = recordClusterIds(producerStart)
        produceMessage(producer)
        producer.metrics = undefined
        producer.clusterId(25, () => {})
        produceMessage(producer)

        assert.deepStrictEqual(clusterIds, [undefined, undefined])
      })

      it('reports no cluster id for releases without clusterId()', () => {
        const clusterIds = recordClusterIds(producerStart)
        const producer = stageNativeProducer(undefined)

        producer.isConnectedValue = true
        producer.emit('ready')
        produceMessage(producer)

        assert.deepStrictEqual(clusterIds, [undefined])
      })

      it('reports the last configured native alias on a producer', () => {
        const servers = []
        const subscriber = (ctx) => servers.push(ctx.bootstrapServers)
        clusterIdSubscribers.push({ channel: producerStart, subscriber })
        producerStart.subscribe(subscriber)
        const producer = stageNativeProducer(undefined, {
          'bootstrap.servers': 'bootstrap:9092',
          'metadata.broker.list': 'alias:9092',
        })
        const reverseOrder = stageNativeProducer(undefined, {
          'metadata.broker.list': 'alias:9092',
          'bootstrap.servers': 'bootstrap:9092',
        })

        producer.isConnectedValue = true
        reverseOrder.isConnectedValue = true
        produceMessage(producer)
        produceMessage(reverseOrder)

        assert.deepStrictEqual(servers, ['alias:9092', 'bootstrap:9092'])
      })

      /**
       * @param {((timeout: number, callback: Function) => void) | undefined} clusterId Stub of `clusterId()`.
       * @param {Record<string, string>} [config]
       */
      function stageNativeConsumer (clusterId, config = {
        'bootstrap.servers': 'kafka-1:9092,kafka-2:9092',
        'group.id': 'group',
      }) {
        class KafkaConsumer extends EventEmitter {
          /**
           * @param {Record<string, string>} config
           */
          constructor (config) {
            super()
            this.globalConfig = config
          }

          isConnectedValue = false
          metrics = {}
          topic = 'topic'
          offset = 1
          /** When set, `consume()` delivers the messages only once `deliverPending()` is called. */
          deferDelivery = false
          /** @type {Array<() => void>} */
          pendingDeliveries = []

          isConnected () {
            return this.isConnectedValue
          }

          /**
           * @param {number} numMessages
           * @param {Function} callback
           */
          consume (numMessages, callback) {
            const message = { topic: this.topic, partition: 0, offset: this.offset, value: Buffer.from('message') }
            const deliver = () => callback(null, [message])
            if (this.deferDelivery) {
              this.pendingDeliveries.push(deliver)
            } else {
              deliver()
            }
          }

          deliverPending () {
            for (const deliver of this.pendingDeliveries.splice(0)) deliver()
          }

          commit () {}
        }
        if (clusterId) KafkaConsumer.prototype.clusterId = clusterId
        CLUSTER_ID_HOOK(KafkaConsumer)

        const module = { KafkaConsumer }
        HOOK(module)
        return new module.KafkaConsumer(config)
      }

      it('reports the brokers even while the cluster id is pending', () => {
        const consumed = []
        const subscriber = (ctx) => consumed.push({ bootstrapServers: ctx.bootstrapServers, clusterId: ctx.clusterId })
        clusterIdSubscribers.push({ channel: consumerStart, subscriber })
        consumerStart.subscribe(subscriber)
        let answerLookup
        const consumer = stageNativeConsumer((timeout, callback) => { answerLookup = callback })

        consumer.isConnectedValue = true
        consumer.emit('ready')
        consumer.clusterId(25, () => {})
        consumer.consume(1, () => {})
        answerLookup(null, 'cluster-1')
        consumer.consume(1, () => {})

        assert.deepStrictEqual(consumed, [
          { bootstrapServers: 'kafka-1:9092,kafka-2:9092', clusterId: undefined },
          { bootstrapServers: 'kafka-1:9092,kafka-2:9092', clusterId: 'cluster-1' },
        ])
      })

      it('reports the cluster id of messages delivered after the lookup settled', () => {
        const clusterIds = recordClusterIds(consumerStart)
        /** @type {Function} */
        let answerLookup = () => {}
        const consumer = stageNativeConsumer((timeout, callback) => { answerLookup = callback })
        consumer.deferDelivery = true

        consumer.isConnectedValue = true
        consumer.emit('ready')
        consumer.clusterId(25, () => {})
        consumer.consume(1, () => {})
        answerLookup(null, 'cluster-1')
        consumer.deliverPending()

        assert.deepStrictEqual(clusterIds, ['cluster-1'])
      })

      it('reports the metadata.broker.list alias on a native consumer', () => {
        const servers = []
        const subscriber = (ctx) => servers.push(ctx.bootstrapServers)
        clusterIdSubscribers.push({ channel: consumerStart, subscriber })
        consumerStart.subscribe(subscriber)
        const consumer = stageNativeConsumer(undefined, { 'group.id': 'group', 'metadata.broker.list': 'alias:9092' })

        consumer.isConnectedValue = true
        consumer.emit('ready')
        consumer.consume(1, () => {})

        assert.deepStrictEqual(servers, ['alias:9092'])
      })

      it('commits only the calling consumer offsets for the same topic and partition on two clusters', () => {
        recordClusterIds(consumerStart)
        const commits = recordCommits()

        const consumers = ['cluster-a', 'cluster-b'].map((clusterId, index) => {
          const consumer = stageNativeConsumer((timeout, callback) => callback(null, clusterId))
          consumer.topic = 'shared-topic'
          consumer.offset = 10 + index
          consumer.isConnectedValue = true
          consumer.clusterId(25, () => {})
          return consumer
        })
        consumers[1].consume(1, () => {})
        consumers[0].consume(1, () => {})
        consumers[0].topic = 'other-topic'
        consumers[0].offset = 12
        consumers[0].consume(1, () => {})
        consumers[0].commit()
        consumers[1].commit()

        assert.deepStrictEqual(commits, [
          [
            { topic: 'shared-topic', partition: 0, offset: 10, groupId: 'group', clusterId: 'cluster-a' },
            { topic: 'other-topic', partition: 0, offset: 12, groupId: 'group', clusterId: 'cluster-a' },
          ],
          [{ topic: 'shared-topic', partition: 0, offset: 11, groupId: 'group', clusterId: 'cluster-b' }],
        ])
      })

      it('clears cached metadata and offsets when a native consumer reconnects', () => {
        const clusterIds = recordClusterIds(consumerStart)
        const commits = recordCommits()
        let clusterId = 'cluster-1'
        const consumer = stageNativeConsumer((timeout, callback) => callback(null, clusterId))

        consumer.isConnectedValue = true
        consumer.clusterId(25, () => {})
        consumer.consume(1, () => {})
        consumer.deferDelivery = true
        let deliveredOffset
        consumer.consume(1, (error, [message]) => {
          assert.ifError(error)
          deliveredOffset = message.offset
        })
        consumer.isConnectedValue = false
        consumer.metrics = {}
        consumer.emit('disconnected')
        clusterId = 'cluster-2'
        consumer.isConnectedValue = true
        consumer.clusterId(25, () => {})
        consumer.deliverPending()
        consumer.commit()
        assert.deepStrictEqual(commits.flat(), [])
        consumer.deferDelivery = false
        consumer.offset = 2
        consumer.consume(1, () => {})
        consumer.commit()

        assert.strictEqual(deliveredOffset, 1)
        assert.deepStrictEqual(clusterIds, ['cluster-1', 'cluster-1', 'cluster-2'])
        assert.deepStrictEqual(commits.flat(), [
          { topic: 'topic', partition: 0, offset: 2, groupId: 'group', clusterId: 'cluster-2' },
        ])
      })
    })
  })
})
