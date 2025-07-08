'use strict'

const { randomUUID } = require('crypto')
const { expect } = require('chai')
const semver = require('semver')
const dc = require('dc-polyfill')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const { expectedSchema, rawExpectedSchema } = require('./naming')
const DataStreamsContext = require('../../dd-trace/src/datastreams/context')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH, DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')

const testKafkaClusterId = '5L6g3nShT-eMCtK--X86sw'

const getDsmPathwayHash = (testTopic, clusterIdAvailable, isProducer, parentHash) => {
  let edgeTags
  if (isProducer) {
    edgeTags = ['direction:out', 'topic:' + testTopic, 'type:kafka']
  } else {
    edgeTags = ['direction:in', 'group:test-group', 'topic:' + testTopic, 'type:kafka']
  }

  if (clusterIdAvailable) {
    edgeTags.push(`kafka_cluster_id:${testKafkaClusterId}`)
  }
  edgeTags.sort()
  return computePathwayHash('test', 'tester', edgeTags, parentHash)
}

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
      let expectedProducerHash
      let expectedConsumerHash
      let testTopic

      describe('without configuration', () => {
        const messages = [{ key: 'key1', value: 'test2' }]
        const messages2 = [{ key: 'key2', value: 'test3' }]

        beforeEach(async () => {
          process.env.DD_DATA_STREAMS_ENABLED = 'true'
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
          // KAFKAJS_NO_PARTITIONER_WARNING=1
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
          expectedProducerHash = getDsmPathwayHash(testTopic, clusterIdAvailable, true, ENTRY_PARENT_HASH)
          expectedConsumerHash = getDsmPathwayHash(testTopic, clusterIdAvailable, false, expectedProducerHash)
        })

        describe('producer', () => {
          it('should be instrumented', async () => {
            const meta = {
              'span.kind': 'producer',
              component: 'kafkajs',
              'pathway.hash': expectedProducerHash.readBigUInt64BE(0).toString(),
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

              expect(span).to.include({
                name: resourceName,
                service: expectedSchema.send.serviceName,
                resource: resourceName,
                error: 1
              })

              expect(span.meta).to.include({
                [ERROR_TYPE]: error.name,
                [ERROR_MESSAGE]: error.message,
                [ERROR_STACK]: error.stack,
                component: 'kafkajs'
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
              try {
                await producer.send({ topic: testTopic, messages })
                expect(true).to.be.false('First producer.send() should have thrown an error')
              } catch (e) {
                expect(e).to.equal(error)
              }
              expect(messages[0].headers).to.have.property('x-datadog-trace-id')

              // restore the stub to allow the next send to succeed
              sendRequestStub.restore()

              const result2 = await producer.send({ topic: testTopic, messages: messages2 })
              expect(messages2[0].headers).to.be.undefined
              expect(result2[0].errorCode).to.equal(0)
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
                'pathway.hash': expectedConsumerHash.readBigUInt64BE(0).toString(),
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
                expect(currentSpan).to.not.equal(firstSpan)
                expect(currentSpan.context()._name).to.equal(expectedSchema.receive.opName)
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

              expect(span).to.include({
                name: 'kafka.consume',
                service: 'test-kafka',
                resource: testTopic
              })

              expect(parseInt(span.parent_id.toString())).to.be.gt(0)
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
                expect(batch.isEmpty()).to.be.false
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
              expect(ctx.currentStore.span).to.not.be.null
              afterStart.unsubscribe(spy)
            })
            afterStart.subscribe(spy)

            let eachMessage = async ({ topic, partition, message }) => {
              try {
                expect(spy).to.have.been.calledOnce

                const channelMsg = spy.firstCall.args[0]
                expect(channelMsg).to.not.undefined
                expect(channelMsg.topic).to.eq(testTopic)
                expect(channelMsg.message.key).to.not.undefined
                expect(channelMsg.message.key.toString()).to.eq(messages[0].key)
                expect(channelMsg.message.value).to.not.undefined
                expect(channelMsg.message.value.toString()).to.eq(messages[0].value)

                const name = spy.firstCall.args[1]
                expect(name).to.eq(afterStart.name)

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
              expect(tracer.scope().active()).to.not.be.null
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

        describe('data stream monitoring', () => {
          let consumer

          beforeEach(async () => {
            tracer.init()
            tracer.use('kafkajs', { dsmEnabled: true })
            consumer = kafka.consumer({ groupId: 'test-group' })
            await consumer.connect()
            await consumer.subscribe({ topic: testTopic })
          })

          before(() => {
            clusterIdAvailable = semver.intersects(version, '>=1.13')
            expectedProducerHash = getDsmPathwayHash(testTopic, clusterIdAvailable, true, ENTRY_PARENT_HASH)
            expectedConsumerHash = getDsmPathwayHash(testTopic, clusterIdAvailable, false, expectedProducerHash)
          })

          afterEach(async () => {
            await consumer.disconnect()
          })

          describe('checkpoints', () => {
            let setDataStreamsContextSpy

            beforeEach(() => {
              setDataStreamsContextSpy = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
            })

            afterEach(() => {
              setDataStreamsContextSpy.restore()
            })

            it('Should set a checkpoint on produce', async () => {
              const messages = [{ key: 'consumerDSM1', value: 'test2' }]
              await sendMessages(kafka, testTopic, messages)
              expect(setDataStreamsContextSpy.args[0][0].hash).to.equal(expectedProducerHash)
            })

            it('Should set a checkpoint on consume (eachMessage)', async () => {
              const runArgs = []
              await consumer.run({
                eachMessage: async () => {
                  runArgs.push(setDataStreamsContextSpy.lastCall.args[0])
                }
              })
              await sendMessages(kafka, testTopic, messages)
              await consumer.disconnect()
              for (const runArg of runArgs) {
                expect(runArg.hash).to.equal(expectedConsumerHash)
              }
            })

            it('Should set a checkpoint on consume (eachBatch)', async () => {
              const runArgs = []
              await consumer.run({
                eachBatch: async () => {
                  runArgs.push(setDataStreamsContextSpy.lastCall.args[0])
                }
              })
              await sendMessages(kafka, testTopic, messages)
              await consumer.disconnect()
              for (const runArg of runArgs) {
                expect(runArg.hash).to.equal(expectedConsumerHash)
              }
            })

            it('Should set a message payload size when producing a message', async () => {
              const messages = [{ key: 'key1', value: 'test2' }]
              if (DataStreamsProcessor.prototype.recordCheckpoint.isSinonProxy) {
                DataStreamsProcessor.prototype.recordCheckpoint.restore()
              }
              const recordCheckpointSpy = sinon.spy(DataStreamsProcessor.prototype, 'recordCheckpoint')
              await sendMessages(kafka, testTopic, messages)
              expect(recordCheckpointSpy.args[0][0].hasOwnProperty('payloadSize'))
              recordCheckpointSpy.restore()
            })

            it('Should set a message payload size when consuming a message', async () => {
              const messages = [{ key: 'key1', value: 'test2' }]
              if (DataStreamsProcessor.prototype.recordCheckpoint.isSinonProxy) {
                DataStreamsProcessor.prototype.recordCheckpoint.restore()
              }
              const recordCheckpointSpy = sinon.spy(DataStreamsProcessor.prototype, 'recordCheckpoint')
              await sendMessages(kafka, testTopic, messages)
              await consumer.run({
                eachMessage: async () => {
                  expect(recordCheckpointSpy.args[0][0].hasOwnProperty('payloadSize'))
                  recordCheckpointSpy.restore()
                }
              })
            })
          })

          describe('backlogs', () => {
            let setOffsetSpy

            beforeEach(() => {
              setOffsetSpy = sinon.spy(tracer._tracer._dataStreamsProcessor, 'setOffset')
            })

            afterEach(() => {
              setOffsetSpy.restore()
            })

            if (semver.intersects(version, '>=1.10')) {
              it('Should add backlog on consumer explicit commit', async () => {
                // Send a message, consume it, and record the last consumed offset
                let commitMeta
                const deferred = {}
                deferred.promise = new Promise((resolve, reject) => {
                  deferred.resolve = resolve
                  deferred.reject = reject
                })
                await consumer.run({
                  eachMessage: async payload => {
                    const { topic, partition, message } = payload
                    commitMeta = {
                      topic,
                      partition,
                      offset: Number(message.offset)
                    }
                    deferred.resolve()
                  },
                  autoCommit: false
                })
                await sendMessages(kafka, testTopic, messages)
                await deferred.promise
                await consumer.disconnect() // Flush ongoing `eachMessage` calls
                for (const call of setOffsetSpy.getCalls()) {
                  expect(call.args[0]).to.not.have.property('type', 'kafka_commit')
                }

                /**
                   * No choice but to reinitialize everything, because the only way to flush eachMessage
                   * calls is to disconnect.
                   */
                consumer.connect()
                await sendMessages(kafka, testTopic, messages)
                await consumer.run({ eachMessage: async () => {}, autoCommit: false })
                setOffsetSpy.resetHistory()
                await consumer.commitOffsets([commitMeta])
                await consumer.disconnect()

                // Check our work
                const runArg = setOffsetSpy.lastCall.args[0]
                expect(setOffsetSpy).to.be.calledOnce
                expect(runArg).to.have.property('offset', commitMeta.offset)
                expect(runArg).to.have.property('partition', commitMeta.partition)
                expect(runArg).to.have.property('topic', commitMeta.topic)
                expect(runArg).to.have.property('type', 'kafka_commit')
                expect(runArg).to.have.property('consumer_group', 'test-group')
              })
            }

            it('Should add backlog on producer response', async () => {
              await sendMessages(kafka, testTopic, messages)
              expect(setOffsetSpy).to.be.calledOnce
              const { topic } = setOffsetSpy.lastCall.args[0]
              expect(topic).to.equal(testTopic)
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
