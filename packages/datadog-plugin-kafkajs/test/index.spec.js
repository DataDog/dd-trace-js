'use strict'

const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')

const { expect } = require('chai')
const dc = require('dc-polyfill')
const { describe, it, beforeEach, afterEach } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { assertObjectContains } = require('../../../integration-tests/helpers')

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
      let clusterIdAvailable
      let testTopic

      describe('without configuration', () => {
        const messages = [{ key: 'key1', value: 'test2' }]
        const messages2 = [{ key: 'key2', value: 'test3' }]

        beforeEach(async () => {
          tracer = require('../../dd-trace')
          await agent.load('kafkajs')
          const lib = require(`../../../versions/kafkajs@${version}`).get()
          Kafka = lib.Kafka
          Broker = require(`../../../versions/kafkajs@${version}/node_modules/kafkajs/src/broker`)
          kafka = new Kafka({
            clientId: `kafkajs-test-${version}`,
            brokers: ['127.0.0.1:9092'],
            logLevel: lib.logLevel.WARN
          })
          testTopic = `test-topic-${randomUUID()}`
          admin = kafka.admin()
          await admin.createTopics({
            topics: [{
              topic: testTopic,
              numPartitions: 1,
              replicationFactor: 1
            }]
          })
          clusterIdAvailable = semver.intersects(version, '>=1.13')
        })

        describe('producer', () => {
          it('should be instrumented', async () => {
            const meta = {
              'span.kind': 'producer',
              component: 'kafkajs',
              'messaging.destination.name': testTopic,
              'messaging.kafka.bootstrap.servers': '127.0.0.1:9092'
            }
            if (clusterIdAvailable) meta['kafka.cluster_id'] = testKafkaClusterId

            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.send.opName,
              service: expectedSchema.send.serviceName,
              meta,
              metrics: {
                'kafka.batch_size': messages.length
              },
              resource: testTopic,
              error: 0

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
                  component: 'kafkajs'
                }
              })
            })

            try {
              await producer.connect()
              await producer.send({
                testTopic,
                messages: 'Oh no!'
              })
            } catch (e) {
              error = e
              await producer.disconnect()
              return expectedSpanPromise
            }
          })
          // Dynamic broker list support added in 1.14/2.0 (https://github.com/tulios/kafkajs/commit/62223)
          if (semver.intersects(version, '>=1.14')) {
            it('should not extract bootstrap servers when initialized with a function', async () => {
              const expectedSpanPromise = agent.assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span.meta).to.not.have.any.keys(['messaging.kafka.bootstrap.servers'])
              })

              kafka = new Kafka({
                clientId: `kafkajs-test-${version}`,
                brokers: () => ['127.0.0.1:9092']
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
                  retries: 0
                }
              })

              sendRequestStub = sinon.stub(Broker.prototype, 'produce').rejects(error)

              producer = otherKafka.producer({ transactionTimeout: 10 })
              await producer.connect()
            })

            afterEach(() => {
              sendRequestStub.restore()
            })

            it('should hit an error for the first send and not inject headers in later sends', async () => {
              await assert.rejects(producer.send({ topic: testTopic, messages }), error)

              expect(messages[0].headers).to.have.property('x-datadog-trace-id')

              // restore the stub to allow the next send to succeed
              sendRequestStub.restore()

              const result2 = await producer.send({ topic: testTopic, messages: messages2 })
              assert.strictEqual(messages2[0].headers, undefined)
              assert.strictEqual(result2[0].errorCode, 0)
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
                component: 'kafkajs',
                'messaging.destination.name': testTopic
              },
              resource: testTopic,
              error: 0,
              type: 'worker'
            })

            await consumer.run({
              eachMessage: () => {}
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
              const span = traces[0][0]

              assertObjectContains(span, {
                name: 'kafka.consume',
                service: 'test-kafka',
                resource: testTopic
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
                component: 'kafkajs'
              },
              resource: testTopic,
              error: 1,
              type: 'worker'

            })

            await consumer.subscribe({ topic: testTopic, fromBeginning: true })
            await consumer.run({
              eachMessage: async ({ topic, partition, message }) => {
                throw fakeError
              }
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
                  expect(spy).to.have.been.calledOnceWith(undefined, beforeFinish.name)

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
      })
    })
  })
})

function expectSpanWithDefaults (expected) {
  const { service } = expected.meta
  expected = withDefaults({
    name: expected.name,
    service,
    meta: expected.meta
  }, expected)
  return expectSomeSpan(agent, expected)
}

async function sendMessages (kafka, topic, messages) {
  const producer = kafka.producer()
  await producer.connect()
  await producer.send({
    topic,
    messages
  })
  await producer.disconnect()
}
