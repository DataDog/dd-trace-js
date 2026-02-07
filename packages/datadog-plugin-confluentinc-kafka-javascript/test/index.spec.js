'use strict'

const assert = require('node:assert/strict')

const { randomUUID } = require('node:crypto')
const { describe, it, beforeEach, afterEach } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { expectedSchema } = require('./naming')

describe('Plugin', () => {
  const module = '@confluentinc/kafka-javascript'
  const groupId = 'test-group-confluent'

  describe('confluentinc-kafka-javascript', function () {
    this.timeout(30000)

    afterEach(() => {
      return agent.close({ ritmReset: false })
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
          tracer = require('../../dd-trace')
          await agent.load('confluentinc-kafka-javascript')
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
                await sendMessages(kafka, testTopic, messages = [{ key: 'key1' }])
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

              await withTimeout(
                sendMessages(kafka, testTopic, messages),
                20000,
                `Timeout: Did not produce message on topic "${testTopic}" within 20000ms`
              )
              await withTimeout(
                consumerReceiveMessagePromise,
                20000,
                `Timeout: Did not receive message on topic "${testTopic}" within 20000ms`
              )
              return expectedSpanPromise
            })

            it('should run the consumer in the context of the consumer span', done => {
              const firstSpan = tracer.scope().active()
              let consumerReceiveMessagePromise
              let eachMessage = async ({ topic, partition, message }) => {
                const currentSpan = tracer.scope().active()

                try {
                  assert.notStrictEqual(currentSpan, firstSpan)
                  assert.strictEqual(currentSpan.context()._name, expectedSchema.receive.opName)
                  done()
                } catch (e) {
                  done(e)
                } finally {
                  eachMessage = async () => {} // avoid being called for each message
                }
              }

              consumer.run({ eachMessage: (...args) => eachMessage(...args) })
                .then(() => sendMessages(kafka, testTopic, messages))
                .then(() => consumerReceiveMessagePromise)
                .catch(done)
            })

            it('should propagate context', async () => {
              const expectedSpanPromise = agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                assertObjectContains(span, {
                  name: 'kafka.consume',
                  service: 'test-kafka',
                  resource: testTopic,
                })

                assert.ok(parseInt(span.parent_id.toString()) > 0)
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
        })

        // Adding tests for the native API
        describe('rdKafka API', () => {
          let nativeProducer
          let nativeConsumer
          let Producer
          let Consumer

          beforeEach(async () => {
            tracer = require('../../dd-trace')
            const lib = require(`../../../versions/${module}@${version}`).get()
            nativeApi = lib

            await agent.load('confluentinc-kafka-javascript')

            // Get the producer/consumer classes directly from the module
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

              try {
                // Passing invalid arguments should cause an error
                nativeProducer.produce()
              } catch (err) {
                // Error is expected
              }

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

            function consume (consumer, producer, topic, message, timeoutMs = 9500) {
              return /** @type {Promise<void>} */(new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                  reject(new Error(`Timeout: Did not consume message on topic "${topic}" within ${timeoutMs}ms`))
                }, timeoutMs)

                function shouldRetryConsumeError (err) {
                  if (!err) return false

                  const code = typeof err.code === 'number' ? err.code : err.errno
                  const codes = nativeApi?.CODES?.ERRORS

                  if (codes && typeof code === 'number') {
                    // Topic creation is asynchronous and the broker may briefly respond with errors while the topic is being created
                    // and/or a leader is being elected for the partition.
                    return code === codes.ERR_UNKNOWN_TOPIC_OR_PART ||
                      code === codes.ERR_LEADER_NOT_AVAILABLE ||
                      code === codes.ERR_NOT_LEADER_FOR_PARTITION
                  }

                  const msg = err.message?.toLowerCase() ?? ''
                  return msg.includes('unknown topic or partition') ||
                    msg.includes('leader not available') ||
                    msg.includes('not leader for partition')
                }

                function doConsume () {
                  consumer.consume(1, function (err, messages) {
                    if (err && !shouldRetryConsumeError(err)) {
                      clearTimeout(timeoutId)
                      return reject(err)
                    }

                    if (!messages || messages.length === 0) {
                      setTimeout(doConsume, 20)
                      return
                    }

                    const consumedMessage = messages[0]

                    if (consumedMessage.value.toString() !== message.toString()) {
                      setTimeout(doConsume, 20)
                      return
                    }

                    clearTimeout(timeoutId)
                    consumer.unsubscribe()
                    resolve()
                  })
                }
                doConsume()
                producer.produce(topic, null, message, 'native-consumer-key')
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
                const span = traces[0][0]

                assertObjectContains(span, {
                  name: 'kafka.consume',
                  service: 'test-kafka',
                  resource: testTopic,
                })

                assert.ok(parseInt(span.parent_id.toString()) > 0)
              }, { timeoutMs: 10000 })
              nativeConsumer.setDefaultConsumeTimeout(10)
              nativeConsumer.subscribe([testTopic])

              // Send a test message using the producer
              const message = Buffer.from('test message propagation for native consumer 1')

              await consume(nativeConsumer, nativeProducer, testTopic, message)

              return expectedSpanPromise
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

async function withTimeout (promise, timeoutMs, message) {
  let timeoutId
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

async function waitForTopicReady (admin, topic, timeoutMs = 20000) {
  if (typeof admin?.fetchTopicMetadata !== 'function') return

  const start = Date.now()
  while ((Date.now() - start) < timeoutMs) {
    try {
      const meta = await admin.fetchTopicMetadata({ topics: [topic], timeout: 1000 })
      const topicMeta = Array.isArray(meta) ? meta[0] : meta?.topics?.[0]

      const partitions = topicMeta?.partitions
      if (Array.isArray(partitions) && partitions.length > 0 && partitions.every(p => typeof p.leader === 'number' && p.leader >= 0)) {
        return
      }
    } catch {
      // Topic creation is async; metadata/leader errors can be transient.
    }

    await new Promise(resolve => setTimeout(resolve, 50))
  }

  throw new Error(`Timeout: Topic "${topic}" metadata was not ready within ${timeoutMs}ms`)
}
