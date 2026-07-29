'use strict'

const assert = require('node:assert/strict')

const { randomUUID } = require('node:crypto')
const dc = require('dc-polyfill')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { getMessageSize } = require('../../dd-trace/src/datastreams')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { expectedSchema } = require('./naming')
const { waitForTopicReady } = require('./helpers')

/** @typedef {Array<Record<string, string | Buffer>>} NativeHeaders */

describe('Plugin', () => {
  const module = '@confluentinc/kafka-javascript'
  const groupId = 'test-group-confluent'

  describe('confluentinc-kafka-javascript', function () {
    this.timeout(30000)

    afterEach(() => {
      return agent.close()
    })

    withVersions('confluentinc-kafka-javascript', module, (version) => {
      let kafka
      let admin
      let tracer
      let Kafka
      let ConfluentKafka
      let messages
      let nativeApi
      let testTopic

      describe('without configuration', () => {
        beforeEach(async () => {
          messages = [{ key: 'key1', value: 'test2' }]

          process.env.DD_DATA_STREAMS_ENABLED = 'true'
          tracer = await agent.load('confluentinc-kafka-javascript')
          const lib = require(`../../../versions/${module}@${version}`).get()

          // Store the module for later use
          nativeApi = lib

          // Setup for the KafkaJS wrapper tests
          ConfluentKafka = lib.KafkaJS
          Kafka = ConfluentKafka.Kafka
          kafka = new Kafka({
            kafkaJS: {
              clientId: `kafkajs-test-${version}`,
              brokers: ['127.0.0.1:9092'],
              logLevel: ConfluentKafka.logLevel.WARN,
            },
          })
          testTopic = `test-topic-${randomUUID()}`
          admin = kafka.admin()
          await admin.connect()
          await admin.createTopics({
            topics: [{
              topic: testTopic,
              numPartitions: 1,
              replicationFactor: 1,
            }],
          })

          // `createTopics()` returns before leaders are guaranteed to be elected in this client.
          // If we race ahead immediately, consumers/producers can stall on metadata/leader availability.
          await waitForTopicReady(admin, testTopic)
        })

        afterEach(() => admin.disconnect())

        describe('kafkaJS api', () => {
          describe('producer', () => {
            it('should be instrumented', async () => {
              const expectedSpanPromise = expectSpanWithDefaults({
                name: expectedSchema.send.opName,
                service: expectedSchema.send.serviceName,
                meta: {
                  'span.kind': 'producer',
                  component: 'confluentinc-kafka-javascript',
                  'messaging.destination.name': testTopic,
                  'messaging.kafka.bootstrap.servers': '127.0.0.1:9092',
                },
                metrics: {
                  'kafka.batch_size': messages.length,
                },
                resource: testTopic,
                error: 0,
              })

              await sendMessages(kafka, testTopic, messages)

              return expectedSpanPromise
            })

            it('should be instrumented w/ error', async () => {
              let error

              const expectedSpanPromise = agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                assertObjectContains(span, {
                  name: expectedSchema.send.opName,
                  service: expectedSchema.send.serviceName,
                  resource: testTopic,
                  error: 1,
                })

                assertObjectContains(span.meta, {
                  [ERROR_TYPE]: error.name,
                  [ERROR_MESSAGE]: error.message,
                  [ERROR_STACK]: error.stack,
                  component: 'confluentinc-kafka-javascript',
                })
              }, { timeoutMs: 10000 })

              try {
                messages = [{ key: 'key1' }]
                await sendMessages(kafka, testTopic, messages)
              } catch (e) {
                error = e
                return expectedSpanPromise
              }
            })
          })

          describe('consumer (eachMessage)', () => {
            let consumer

            beforeEach(async () => {
              messages = [{ key: 'key1', value: 'test2' }]
              consumer = kafka.consumer({
                kafkaJS: { groupId, fromBeginning: true, autoCommit: false },
              })
              await consumer.connect()
              await consumer.subscribe({ topic: testTopic })
            })

            afterEach(async () => {
              await consumer.disconnect()
            })

            it('should be instrumented', async () => {
              const expectedSpanPromise = expectSpanWithDefaults({
                name: expectedSchema.receive.opName,
                service: expectedSchema.receive.serviceName,
                meta: {
                  'span.kind': 'consumer',
                  component: 'confluentinc-kafka-javascript',
                  'messaging.destination.name': testTopic,
                },
                resource: testTopic,
                error: 0,
                type: 'worker',
              })

              const consumerReceiveMessagePromise = /** @type {Promise<void>} */(new Promise((resolve, reject) => {
                consumer.run({
                  eachMessage: () => {
                    resolve()
                  },
                })
              }))

              await Promise.all([
                sendMessages(kafka, testTopic, messages),
                consumerReceiveMessagePromise,
                expectedSpanPromise,
              ])
            })

            it('should run the consumer in the context of the consumer span', async () => {
              const firstSpan = tracer.scope().active()
              let hasReceivedMessage = false
              const consumerReceiveMessagePromise = /** @type {Promise<void>} */(new Promise((resolve, reject) => {
                const eachMessage = async () => {
                  if (hasReceivedMessage) return

                  hasReceivedMessage = true
                  const currentSpan = tracer.scope().active()

                  try {
                    assert.notStrictEqual(currentSpan, firstSpan)
                    assert.strictEqual(currentSpan.context()._name, expectedSchema.receive.opName)
                    resolve()
                  } catch (e) {
                    reject(e)
                  }
                }

                consumer.run({ eachMessage }).catch(reject)
              }))

              await sendMessages(kafka, testTopic, messages)
              await consumerReceiveMessagePromise
            })

            it('should propagate context', async () => {
              const expectedSpanPromise = agent.assertSomeTraces(traces => {
                const span = traces[0].find(s => s.name === 'kafka.consume')
                assert.ok(span)

                assertObjectContains(span, {
                  name: 'kafka.consume',
                  service: 'test-kafka',
                  resource: testTopic,
                })

                const parentId = parseInt(span.parent_id.toString(), 10)
                assert.ok(parentId > 0, `Expected ${parentId} > 0`)
              }, { timeoutMs: 10000 })

              let consumerReceiveMessagePromise
              await consumer.run({
                eachMessage: async () => {
                  consumerReceiveMessagePromise = Promise.resolve()
                },
              })
              await sendMessages(kafka, testTopic, messages).then(
                async () => await consumerReceiveMessagePromise
              )
              return expectedSpanPromise
            })

            it('should be instrumented w/ error', async () => {
              const fakeError = new Error('Oh No!')
              const expectedSpanPromise = expectSpanWithDefaults({
                name: expectedSchema.receive.opName,
                service: expectedSchema.receive.serviceName,
                meta: {
                  [ERROR_TYPE]: fakeError.name,
                  [ERROR_MESSAGE]: fakeError.message,
                  [ERROR_STACK]: fakeError.stack,
                  'span.kind': 'consumer',
                  component: 'confluentinc-kafka-javascript',
                  'messaging.destination.name': testTopic,
                },
                resource: testTopic,
                error: 1,
                type: 'worker',
              })

              let consumerReceiveMessagePromise
              const eachMessage = async ({ topic, partition, message }) => {
                consumerReceiveMessagePromise = Promise.resolve()
                throw fakeError
              }

              await consumer.run({ eachMessage })
              await sendMessages(kafka, testTopic, messages).then(
                async () => await consumerReceiveMessagePromise
              )

              return expectedSpanPromise
            })
          })

          describe('consumer (eachBatch)', () => {
            let consumer
            let batchMessages

            beforeEach(async () => {
              batchMessages = [{ key: 'key1', value: 'test2' }, { key: 'key2', value: 'test3' }]
              consumer = kafka.consumer({
                kafkaJS: { groupId, fromBeginning: true, autoCommit: false },
              })
              await consumer.connect()
              await consumer.subscribe({ topic: testTopic })
            })

            afterEach(async () => {
              await consumer.disconnect()
            })

            it('should be instrumented', async () => {
              const expectedSpanPromise = expectSpanWithDefaults({
                name: expectedSchema.receive.opName,
                service: expectedSchema.receive.serviceName,
                meta: {
                  'span.kind': 'consumer',
                  component: 'confluentinc-kafka-javascript',
                  'kafka.topic': testTopic,
                  'messaging.destination.name': testTopic,
                  'messaging.system': 'kafka',
                },
                resource: testTopic,
                error: 0,
                type: 'worker',
              })

              await consumer.run({ eachBatch: () => {} })
              return Promise.all([sendMessages(kafka, testTopic, batchMessages), expectedSpanPromise])
            })

            it('should run the consumer in the context of the consumer span', done => {
              const firstSpan = tracer.scope().active()
              let eachBatch = async ({ batch }) => {
                const currentSpan = tracer.scope().active()

                try {
                  assert.notEqual(currentSpan, firstSpan)
                  assert.strictEqual(currentSpan.context()._name, expectedSchema.receive.opName)
                  eachBatch = () => {} // avoid being called for each message
                  done()
                } catch (e) {
                  eachBatch = () => {}
                  done(e)
                }
              }

              consumer.run({ eachBatch: (...args) => eachBatch(...args) })
                .then(() => sendMessages(kafka, testTopic, batchMessages))
                .catch(done)
            })

            it('should propagate context via span links', async () => {
              const expectedSpanPromise = agent.assertSomeTraces(traces => {
                const span = traces[0][0]
                const links = span.meta['_dd.span_links'] ? JSON.parse(span.meta['_dd.span_links']) : []

                assertObjectContains(span, {
                  name: expectedSchema.receive.opName,
                  service: expectedSchema.receive.serviceName,
                  resource: testTopic,
                })

                // librdkafka may deliver messages across multiple batches,
                // so each batch span will have links for the messages it received.
                assert.ok(links.length >= 1, `expected at least 1 span link, got ${links.length}`)
              }, { timeoutMs: 5000 }) // librdkafka consumer delivery lags the produce by seconds

              await consumer.run({ eachBatch: () => {} })
              await Promise.all([sendMessages(kafka, testTopic, batchMessages), expectedSpanPromise])
            })
          })
        })

        // Adding tests for the native API
        describe('rdKafka API', () => {
          let nativeProducer
          let nativeConsumer
          let Producer
          let Consumer

          beforeEach(async () => {
            Producer = nativeApi.Producer
            Consumer = nativeApi.KafkaConsumer

            nativeProducer = new Producer({
              'bootstrap.servers': '127.0.0.1:9092',
              dr_cb: true,
            })

            await /** @type {Promise<void>} */(new Promise((resolve, reject) => {
              nativeProducer.connect({}, (err) => {
                if (err) {
                  return reject(err)
                }
                resolve()
              })
            }))
          })

          afterEach(async () => {
            await /** @type {Promise<void>} */(new Promise((resolve, reject) => {
              nativeProducer.disconnect((err) => {
                if (err) {
                  return reject(err)
                }
                resolve()
              })
            }))
          })

          describe('producer', () => {
            it('should be instrumented', async () => {
              const expectedSpanPromise = expectSpanWithDefaults({
                name: expectedSchema.send.opName,
                service: expectedSchema.send.serviceName,
                meta: {
                  'span.kind': 'producer',
                  component: 'confluentinc-kafka-javascript',
                  'messaging.destination.name': testTopic,
                  'messaging.kafka.bootstrap.servers': '127.0.0.1:9092',
                },
                resource: testTopic,
                error: 0,
              })

              const message = Buffer.from('test message')
              const key = 'native-key'

              nativeProducer.produce(testTopic, null, message, key)

              return expectedSpanPromise
            })

            it('should include every repeated native header key in the DSM payload size', () => {
              const setCheckpointSpy = sinon.spy(tracer._tracer._dataStreamsProcessor, 'setCheckpoint')
              const startChannel = dc.channel('apm:confluentinc-kafka-javascript:produce:start')
              const message = Buffer.from('native DSM message')
              const key = 'native-dsm-key'
              /** @type {Record<string, string | Buffer | Array<string | Buffer>>} */
              let carrier = {}

              const captureCarrier = (ctx) => { carrier = ctx.messages[0].headers }
              startChannel.subscribe(captureCarrier)

              try {
                nativeProducer.produce(
                  testTopic,
                  null,
                  message,
                  key,
                  undefined,
                  undefined,
                  [{ 'content-type': 'text' }, { 'content-type': 'application/json' }]
                )

                assert.deepStrictEqual(carrier['content-type'], ['text', 'application/json'])

                let expectedSize = message.length + Buffer.byteLength(key)
                for (const headerKey of Object.keys(carrier)) {
                  // DsmPathwayCodec writes its header after the checkpoint is sized.
                  if (headerKey === 'dd-pathway-ctx-base64') continue

                  const value = carrier[headerKey]
                  const values = Array.isArray(value) ? value : [value]
                  for (const single of values) {
                    expectedSize += Buffer.byteLength(headerKey) +
                      (Buffer.isBuffer(single) ? single.length : Buffer.byteLength(single))
                  }
                }

                assert.strictEqual(setCheckpointSpy.lastCall.args[3], expectedSize)
                // Repeating 'content-type' is what the generic carrier walk would miss.
                assert.notStrictEqual(getMessageSize({ key, value: message, headers: carrier }), expectedSize)
              } finally {
                startChannel.unsubscribe(captureCarrier)
                setCheckpointSpy.restore()
              }
            })

            it('should be instrumented with error', async () => {
              const expectedSpanPromise = agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                assertObjectContains(span, {
                  name: expectedSchema.send.opName,
                  service: expectedSchema.send.serviceName,
                  error: 1,
                })

                assertObjectContains(span.meta, {
                  component: 'confluentinc-kafka-javascript',
                })

                assert.ok(span.meta[ERROR_TYPE])
                assert.ok(span.meta[ERROR_MESSAGE])
              }, { timeoutMs: 10000 })

              assert.throws(() => {
                nativeProducer.produce(
                  testTopic,
                  null,
                  Buffer.from('invalid native header'),
                  'native-key',
                  undefined,
                  undefined,
                  [{ invalid: 42 }]
                )
              }, { message: 'Header value must be a string or buffer' })

              return expectedSpanPromise
            })
          })

          describe('consumer', () => {
            beforeEach(async () => {
              nativeConsumer = new Consumer({
                'bootstrap.servers': '127.0.0.1:9092',
                'group.id': groupId,
                'enable.auto.commit': false,
              }, {
                'auto.offset.reset': 'earliest',
              })

              await /** @type {Promise<void>} */(new Promise((resolve, reject) => {
                nativeConsumer.connect({}, (err) => {
                  if (err) {
                    return reject(err)
                  }
                  resolve()
                })
              }))
            })

            afterEach(async () => {
              await nativeConsumer.unsubscribe()
              await /** @type {Promise<void>} */(new Promise((resolve, reject) => {
                nativeConsumer.disconnect((err) => {
                  if (err) {
                    return reject(err)
                  }
                  resolve()
                })
              }))
            })

            /**
             * @param {{ consume: Function, unsubscribe: Function }} consumer
             * @param {{ produce: Function }} producer
             * @param {string} topic
             * @param {Buffer} message
             * @param {number} [timeoutMs]
             * @param {(message: { value: Buffer, headers?: NativeHeaders }) => void} [onMessage]
             * @param {Array<Record<string, string | Buffer> | null>} [headers]
             *   Entries may be malformed; the boundary decides what reaches the library.
             */
            function consume (
              consumer,
              producer,
              topic,
              message,
              timeoutMs = 9500,
              onMessage,
              headers
            ) {
              return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
                let retryId
                let settled = false
                const timeoutId = setTimeout(() => {
                  settle(new Error(`Timeout: Did not consume message on topic "${topic}" within ${timeoutMs}ms`))
                }, timeoutMs)

                function settle (error) {
                  if (settled) return
                  settled = true
                  clearTimeout(timeoutId)
                  clearTimeout(retryId)

                  let unsubscribeError
                  try {
                    consumer.unsubscribe()
                  } catch (unsubscribeFailure) {
                    unsubscribeError = unsubscribeFailure
                  }

                  const rejection = error || unsubscribeError
                  if (rejection) {
                    reject(rejection)
                  } else {
                    resolve()
                  }
                }

                function retry () {
                  if (!settled) retryId = setTimeout(doConsume, 20)
                }

                function doConsume () {
                  consumer.consume(1, function (error, messages) {
                    if (settled) return

                    if (error) {
                      settle(error)
                      return
                    }

                    if (!messages || messages.length === 0) {
                      retry()
                      return
                    }

                    const consumedMessage = messages[0]

                    if (consumedMessage.value.toString() !== message.toString()) {
                      retry()
                      return
                    }

                    try {
                      if (typeof onMessage === 'function') {
                        onMessage(consumedMessage)
                      }
                    } catch (error) {
                      settle(error)
                      return
                    }

                    settle()
                  })
                }
                doConsume()
                try {
                  producer.produce(topic, null, message, 'native-consumer-key', undefined, undefined, headers)
                } catch (error) {
                  settle(error)
                }
              }))
            }

            it('should be instrumented', async () => {
              const expectedSpanPromise = expectSpanWithDefaults({
                name: expectedSchema.receive.opName,
                service: expectedSchema.receive.serviceName,
                meta: {
                  'span.kind': 'consumer',
                  component: 'confluentinc-kafka-javascript',
                  'messaging.destination.name': testTopic,
                },
                resource: testTopic,
                error: 0,
                type: 'worker',
              })

              nativeConsumer.setDefaultConsumeTimeout(10)
              nativeConsumer.subscribe([testTopic])

              // Send a test message using the producer
              const message = Buffer.from('test message for native consumer')

              await consume(nativeConsumer, nativeProducer, testTopic, message)

              return expectedSpanPromise
            })

            it('should propagate context', async () => {
              const expectedSpanPromise = agent.assertSomeTraces(traces => {
                const span = traces[0].find(s => s.name === 'kafka.consume')
                assert.ok(span)

                assertObjectContains(span, {
                  name: 'kafka.consume',
                  service: 'test-kafka',
                  resource: testTopic,
                })

                const parentId = parseInt(span.parent_id.toString(), 10)
                assert.ok(parentId > 0, `Expected ${parentId} > 0`)
              }, { timeoutMs: 10000 })
              nativeConsumer.setDefaultConsumeTimeout(10)
              nativeConsumer.subscribe([testTopic])

              // Send a test message using the producer
              const message = Buffer.from('test message propagation for native consumer 1')

              await consume(nativeConsumer, nativeProducer, testTopic, message)

              return expectedSpanPromise
            })

            it('should preserve native application headers and replace stale propagation headers', async () => {
              const message = Buffer.from('test message with native headers')
              const staleTraceId = 'stale-trace-id'
              const applicationBuffer = Buffer.from([0xde, 0xad, 0xbe, 0xef])

              nativeConsumer.setDefaultConsumeTimeout(10)
              nativeConsumer.subscribe([testTopic])

              await consume(nativeConsumer, nativeProducer, testTopic, message, 9500, (consumedMessage) => {
                const entries = nativeHeaderEntries(consumedMessage.headers)

                assert.deepStrictEqual(entries.filter(([key]) => key === 'content-type'), [
                  ['content-type', Buffer.from('text/plain')],
                  ['content-type', Buffer.from('application/json')],
                ])
                assert.deepStrictEqual(entries.filter(([key]) => key === 'Traceparent'), [
                  ['Traceparent', Buffer.from('application-value')],
                ])
                assert.deepStrictEqual(entries.filter(([key]) => key === 'binary-header'), [
                  ['binary-header', applicationBuffer],
                ])

                const traceId = entries.find(([key]) => key === 'x-datadog-trace-id')
                assert.ok(traceId)
                assert.notStrictEqual(traceId[1].toString(), staleTraceId)
              }, [
                { 'content-type': 'text/plain' },
                { 'content-type': 'application/json' },
                { 'binary-header': applicationBuffer },
                { 'x-datadog-trace-id': staleTraceId },
                { Traceparent: 'application-value' },
              ])
            })

            it('should send generated headers only when the header array is unusable', async () => {
              const message = Buffer.from('test message with an unusable native header array')

              nativeConsumer.setDefaultConsumeTimeout(10)
              nativeConsumer.subscribe([testTopic])

              await consume(nativeConsumer, nativeProducer, testTopic, message, 9500, (consumedMessage) => {
                const keys = nativeHeaderEntries(consumedMessage.headers).map(([key]) => key)

                assert.ok(!keys.includes('content-type'))
                assert.ok(keys.includes('x-datadog-trace-id'))
              }, [
                { 'content-type': 'text/plain' },
                null,
              ])
            })
          })
        })
      })
    })
  })
})

function expectSpanWithDefaults (expected) {
  const { service } = expected.meta
  expected = withDefaults({
    name: expected.name,
    service,
    meta: expected.meta,
  }, expected)
  return expectSomeSpan(agent, expected, 10000)
}

async function sendMessages (kafka, topic, messages) {
  const producer = kafka.producer()
  await producer.connect()
  await producer.send({
    topic,
    messages,
  })
  await producer.disconnect()
}

/**
 * @param {NativeHeaders | undefined} headers `KafkaConsumer~Message.headers`,
 *   absent when the record carries none.
 * @returns {Array<[string, string | Buffer]>} Wire order, duplicates kept.
 */
function nativeHeaderEntries (headers) {
  return (headers ?? []).map((header) => {
    const [key] = Object.keys(header)
    return [key, header[key]]
  })
}
