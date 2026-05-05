'use strict'

const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')

const dc = require('dc-polyfill')
const { describe, it, beforeEach, afterEach } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { clientToCluster } = require('../../datadog-instrumentations/src/helpers/kafka')
const { assertObjectContains, deepFreeze } = require('../../../integration-tests/helpers')

const { expectedSchema, rawExpectedSchema } = require('./naming')

const testKafkaClusterId = '5L6g3nShT-eMCtK--X86sw'

describe('Plugin', () => {
  describe('kafkajs', function () {
    // TODO: remove when new internal trace has landed
    this.timeout(10000)

    afterEach(() => {
      return agent.close({ ritmReset: false })
    })
    withVersions('kafkajs', 'kafkajs', (version) => {
      let kafka
      let admin
      let tracer
      let Kafka
      let Broker
      let testTopic

      describe('without configuration', () => {
        const messages = [{ key: 'key1', value: 'test2' }]

        beforeEach(async () => {
          tracer = require('../../dd-trace')
          await agent.load('kafkajs')
          const lib = require(`../../../versions/kafkajs@${version}`).get()
          Kafka = lib.Kafka
          Broker = require(`../../../versions/kafkajs@${version}/node_modules/kafkajs/src/broker`)
          kafka = new Kafka({
            clientId: `kafkajs-test-${version}`,
            brokers: ['127.0.0.1:9092'],
            logLevel: lib.logLevel.WARN,
          })
          testTopic = `test-topic-${randomUUID()}`
          admin = kafka.admin()
          await admin.createTopics({
            waitForLeaders: false,
            topics: [{
              topic: testTopic,
              numPartitions: 1,
              replicationFactor: 1,
            }],
          })
        })

        describe('producer', () => {
          it('should be instrumented', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.send.opName,
              service: expectedSchema.send.serviceName,
              meta: {
                'span.kind': 'producer',
                component: 'kafkajs',
                'messaging.destination.name': testTopic,
                'messaging.kafka.bootstrap.servers': '127.0.0.1:9092',
                'kafka.cluster_id': testKafkaClusterId,
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

          withPeerService(
            () => tracer,
            'kafkajs',
            () => sendMessages(kafka, testTopic, messages),
            '127.0.0.1:9092',
            'messaging.kafka.bootstrap.servers'
          )

          it('should be instrumented w/ error', async () => {
            const producer = kafka.producer()
            const resourceName = expectedSchema.send.opName

            let error

            const expectedSpanPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              assertObjectContains(span, {
                name: resourceName,
                service: expectedSchema.send.serviceName,
                resource: resourceName,
                error: 1,
                meta: {
                  [ERROR_TYPE]: error.name,
                  [ERROR_MESSAGE]: error.message,
                  [ERROR_STACK]: error.stack,
                  component: 'kafkajs',
                },
              })
            })

            try {
              await producer.connect()
              await producer.send({
                testTopic,
                messages: 'Oh no!',
              })
            } catch (e) {
              error = e
              await producer.disconnect()
              return expectedSpanPromise
            }
          })

          it('should not mutate user-supplied message objects', async () => {
            // Deep-freezing the input means any accidental write to a
            // message, its headers, or the array itself throws synchronously.
            const userMessages = deepFreeze([
              { key: 'key', value: 'value', headers: { foo: 'bar' } },
              { key: 'key2', value: 'value2' },
            ])

            await sendMessages(kafka, testTopic, userMessages)
          })

          it('should not call Kafka.admin from instrumentation during normal send', async () => {
            // Spy after the test setup has already created topics; from here
            // on no internal admin connection should be opened.
            const adminSpy = sinon.spy(kafka, 'admin')
            try {
              await sendMessages(kafka, testTopic, messages)
              assert.strictEqual(adminSpy.callCount, 0)
            } finally {
              adminSpy.restore()
            }
          })

          it('should disable header injection when broker advertises Produce <v3', async () => {
            const startCh = dc.channel('apm:kafkajs:produce:start')
            const sentMessageBatches = []
            const captureStart = (ctx) => sentMessageBatches.push({
              messages: ctx.messages,
              disableHeaderInjection: ctx.disableHeaderInjection,
            })
            startCh.subscribe(captureStart)

            const producer = kafka.producer()
            await producer.connect()

            try {
              // Reach into kafkajs's broker pool and downgrade the negotiated
              // Produce version. We can't ask the docker broker to pretend to
              // be <0.11; lying locally is enough to drive the proactive
              // header-support check.
              const cluster = clientToCluster.get(producer)
              cluster.brokerPool.versions[0].maxVersion = 2

              const userMessages = [{ key: 'k', value: 'v' }]
              await producer.send({ topic: testTopic, messages: userMessages })

              assert.strictEqual(sentMessageBatches.length, 1)
              assert.strictEqual(sentMessageBatches[0].disableHeaderInjection, true)
              // Boundary clones with `cloneMessages` when injection is off,
              // so the channel sees a fresh array whose entries have no
              // `headers` field at all (no `{}` seeding) and the user's
              // array stays untouched.
              const [clonedMessage] = sentMessageBatches[0].messages
              assert.notStrictEqual(sentMessageBatches[0].messages, userMessages)
              assert.notStrictEqual(clonedMessage, userMessages[0])
              assert.strictEqual(Object.hasOwn(clonedMessage, 'headers'), false)
              assert.strictEqual(userMessages[0].headers, undefined)
            } finally {
              await producer.disconnect()
              startCh.unsubscribe(captureStart)
            }
          })

          // Dynamic broker list support added in 1.14/2.0 (https://github.com/tulios/kafkajs/commit/62223)
          if (semver.intersects(version, '>=1.14')) {
            it('should not extract bootstrap servers when initialized with a function', async () => {
              const expectedSpanPromise = agent.assertSomeTraces(traces => {
                const span = traces[0][0]
                assert.ok(!((['messaging.kafka.bootstrap.servers']).some(k => Object.hasOwn((span.meta), k))))
              })

              kafka = new Kafka({
                clientId: `kafkajs-test-${version}`,
                brokers: () => ['127.0.0.1:9092'],
              })

              await sendMessages(kafka, testTopic, messages)

              return expectedSpanPromise
            })
          }

          describe('when using a kafka broker version that does not support message headers', function () {
            // kafkajs 1.4.0 is very slow when encountering errors
            this.timeout(30000)

            // we should stub the kafka producer send method to throw a KafkaJSProtocolError
            class KafkaJSProtocolError extends Error {
              constructor (message) {
                super(message)
                this.name = 'KafkaJSProtocolError'
                this.type = 'UNKNOWN'
              }
            }
            let sendRequestStub
            let producer

            const error = new KafkaJSProtocolError()
            error.message = 'Simulated KafkaJSProtocolError UNKNOWN from Broker.sendRequest stub'

            beforeEach(async () => {
              // simulate a kafka error for the broker version not supporting message headers
              const otherKafka = new Kafka({
                clientId: `kafkajs-test-${version}`,
                brokers: ['127.0.0.1:9092'],
                retry: {
                  retries: 0,
                },
              })

              sendRequestStub = sinon.stub(Broker.prototype, 'produce').rejects(error)

              producer = otherKafka.producer({ transactionTimeout: 10 })
              await producer.connect()
            })

            afterEach(() => {
              sendRequestStub.restore()
            })

            it('should hit an error for the first send and not inject headers in later sends', async () => {
              const startCh = dc.channel('apm:kafkajs:produce:start')
              const sentMessageBatches = []
              const captureStart = (ctx) => sentMessageBatches.push(ctx.messages)
              startCh.subscribe(captureStart)

              // Freeze both batches: any boundary or plugin write to the
              // user's array, its messages, or their headers throws here.
              const firstBatch = deepFreeze([{ key: 'key1', value: 'test2' }])
              const secondBatch = deepFreeze([{ key: 'key2', value: 'test3' }])

              try {
                await assert.rejects(producer.send({ topic: testTopic, messages: firstBatch }), error)

                // The first send injects trace headers into the cloned
                // batch that kafkajs serializes.
                assert.ok(Object.hasOwn(sentMessageBatches[0][0].headers, 'x-datadog-trace-id'))

                sendRequestStub.restore()

                const result2 = await producer.send({ topic: testTopic, messages: secondBatch })

                // After UNKNOWN the boundary clones with `cloneMessages`
                // (frozen input stays untouched) and the clone has no
                // `headers` field at all — brokers that reject any header
                // field can recover.
                const [clonedAfterDisable] = sentMessageBatches[1]
                assert.notStrictEqual(clonedAfterDisable, secondBatch[0])
                assert.strictEqual(Object.hasOwn(clonedAfterDisable, 'headers'), false)
                assert.strictEqual(result2[0].errorCode, 0)
              } finally {
                startCh.unsubscribe(captureStart)
              }
            })
          })

          withNamingSchema(
            async () => sendMessages(kafka, testTopic, messages),
            rawExpectedSchema.send
          )
        })

        describe('consumer (eachMessage)', () => {
          let consumer

          beforeEach(async () => {
            consumer = kafka.consumer({ groupId: 'test-group' })
            await consumer.connect()
            await consumer.subscribe({ topic: testTopic, fromBeginning: true })
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
                component: 'kafkajs',
                'messaging.destination.name': testTopic,
              },
              resource: testTopic,
              error: 0,
              type: 'worker',
            })

            await consumer.run({
              eachMessage: () => {},
            })
            await sendMessages(kafka, testTopic, messages)
            return expectedSpanPromise
          })

          it('should run the consumer in the context of the consumer span', done => {
            const firstSpan = tracer.scope().active()

            let eachMessage = async ({ topic, partition, message }) => {
              const currentSpan = tracer.scope().active()

              try {
                assert.notDeepStrictEqual(currentSpan, firstSpan)
                assert.strictEqual(currentSpan.context()._name, expectedSchema.receive.opName)
                done()
              } catch (e) {
                done(e)
              } finally {
                eachMessage = () => {} // avoid being called for each message
              }
            }

            consumer.run({ eachMessage: (...args) => eachMessage(...args) })
              .then(() => sendMessages(kafka, testTopic, messages))
              .catch(done)
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

              assert.ok(parseInt(span.parent_id.toString()) > 0)
            })

            await consumer.run({ eachMessage: () => {} })
            await sendMessages(kafka, testTopic, messages)
            await expectedSpanPromise
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
                component: 'kafkajs',
              },
              resource: testTopic,
              error: 1,
              type: 'worker',

            })

            await consumer.run({
              eachMessage: async ({ topic, partition, message }) => {
                throw fakeError
              },
            })
            await sendMessages(kafka, testTopic, messages)

            return expectedSpanPromise
          })

          it('should run constructor even if no eachMessage supplied', (done) => {
            let eachBatch = async ({ batch }) => {
              try {
                assert.strictEqual(batch.isEmpty(), false)
                done()
              } catch (e) {
                done(e)
              } finally {
                eachBatch = () => {} // avoid being called for each message
              }
            }

            const runResult = consumer.run({ eachBatch: (...args) => eachBatch(...args) })

            if (!runResult || !runResult.then) {
              throw new Error('Consumer.run returned invalid result')
            }

            runResult
              .then(() => sendMessages(kafka, testTopic, messages))
              .catch(done)
          })

          it('should publish on afterStart channel', (done) => {
            const afterStart = dc.channel('dd-trace:kafkajs:consumer:afterStart')

            const spy = sinon.spy((ctx) => {
              assert.ok(ctx.currentStore.span)
              afterStart.unsubscribe(spy)
            })
            afterStart.subscribe(spy)

            let eachMessage = async ({ topic, partition, message }) => {
              try {
                assert.strictEqual(spy.callCount, 1)

                const channelMsg = spy.firstCall.args[0]
                assert.ok(channelMsg)
                assert.strictEqual(channelMsg.topic, testTopic)
                assert.ok(channelMsg.message.key)
                assert.strictEqual(channelMsg.message.key.toString(), messages[0].key)
                assert.ok(channelMsg.message.value)
                assert.strictEqual(channelMsg.message.value.toString(), messages[0].value)

                const name = spy.firstCall.args[1]
                assert.strictEqual(name, afterStart.name)

                done()
              } catch (e) {
                done(e)
              } finally {
                eachMessage = () => {}
              }
            }

            consumer.run({ eachMessage: (...args) => eachMessage(...args) })
              .then(() => sendMessages(kafka, testTopic, messages))
          })

          it('should publish on beforeFinish channel', (done) => {
            const beforeFinish = dc.channel('dd-trace:kafkajs:consumer:beforeFinish')

            const spy = sinon.spy(() => {
              assert.ok(tracer.scope().active())
              beforeFinish.unsubscribe(spy)
            })
            beforeFinish.subscribe(spy)

            let eachMessage = async ({ topic, partition, message }) => {
              setImmediate(() => {
                try {
                  sinon.assert.calledOnceWithExactly(spy, undefined, beforeFinish.name)

                  done()
                } catch (e) {
                  done(e)
                }
              })

              eachMessage = () => {}
            }

            consumer.run({ eachMessage: (...args) => eachMessage(...args) })
              .then(() => sendMessages(kafka, testTopic, messages))
          })

          withNamingSchema(
            async () => {
              await consumer.run({ eachMessage: () => {} })
              await sendMessages(kafka, testTopic, messages)
            },
            rawExpectedSchema.receive
          )
        })

        describe('consumer (eachBatch)', () => {
          let consumer
          const batchMessages = [{ key: 'key1', value: 'test2' }, { key: 'key2', value: 'test3' }]

          beforeEach(async () => {
            consumer = kafka.consumer({ groupId: 'test-group' })
            await consumer.connect()
            await consumer.subscribe({ topic: testTopic, fromBeginning: true })
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
                component: 'kafkajs',
                'kafka.topic': testTopic,
                'messaging.destination.name': testTopic,
                'messaging.system': 'kafka',
                'kafka.cluster_id': testKafkaClusterId,
              },
              metrics: {
                'messaging.batch.message_count': batchMessages.length,
              },
              resource: testTopic,
              error: 0,
              type: 'worker',
            })

            await consumer.run({
              eachBatch: () => {},
            })
            return Promise.all([sendMessages(kafka, testTopic, batchMessages), expectedSpanPromise])
          })

          it('should run the consumer in the context of the consumer span', done => {
            const firstSpan = tracer.scope().active()

            let eachBatch = async ({ batch }) => {
              const currentSpan = tracer.scope().active()

              try {
                assert.notEqual(currentSpan, firstSpan)
                assert.strictEqual(currentSpan.context()._name, expectedSchema.receive.opName)
                done()
              } catch (e) {
                done(e)
              } finally {
                eachBatch = () => {} // avoid being called for each message
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

              assert.strictEqual(links.length, batchMessages.length)
            })

            await consumer.run({ eachBatch: () => {} })
            await Promise.all([sendMessages(kafka, testTopic, batchMessages), expectedSpanPromise])
          })

          it('should not fail when messages have headers without trace context', async () => {
            const messagesWithHeaders = [
              { key: 'key1', value: 'test1', headers: { 'x-custom-header': 'value' } },
            ]
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.receive.opName,
              service: expectedSchema.receive.serviceName,
              meta: {
                'span.kind': 'consumer',
                component: 'kafkajs',
                'kafka.topic': testTopic,
                'messaging.destination.name': testTopic,
                'messaging.system': 'kafka',
                'kafka.cluster_id': testKafkaClusterId,
              },
              resource: testTopic,
              error: 0,
              type: 'worker',
            })

            await consumer.run({ eachBatch: () => {} })
            return Promise.all([sendMessages(kafka, testTopic, messagesWithHeaders), expectedSpanPromise])
          })

          withNamingSchema(
            async () => {
              await consumer.run({ eachBatch: () => {} })
              await sendMessages(kafka, testTopic, batchMessages)
            },
            rawExpectedSchema.receive
          )
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
  return expectSomeSpan(agent, expected)
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
