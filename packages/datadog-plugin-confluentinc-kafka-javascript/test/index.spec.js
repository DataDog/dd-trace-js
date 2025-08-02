'use strict'

const { randomUUID } = require('crypto')
const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { expectedSchema } = require('./naming')

const DataStreamsContext = require('../../dd-trace/src/datastreams/context')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH, DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')

const getDsmPathwayHash = (testTopic, isProducer, parentHash) => {
  let edgeTags
  if (isProducer) {
    edgeTags = ['direction:out', 'topic:' + testTopic, 'type:kafka']
  } else {
    edgeTags = ['direction:in', 'group:test-group-confluent', 'topic:' + testTopic, 'type:kafka']
  }

  edgeTags.sort()
  return computePathwayHash('test', 'tester', edgeTags, parentHash)
}

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
              logLevel: ConfluentKafka.logLevel.WARN
            }
          })
          testTopic = `test-topic-${randomUUID()}`
          admin = kafka.admin()
          await admin.connect()
          await admin.createTopics({
            topics: [{
              topic: testTopic,
              numPartitions: 1,
              replicationFactor: 1
            }]
          })
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
                  'messaging.kafka.bootstrap.servers': '127.0.0.1:9092'
                },
                metrics: {
                  'kafka.batch_size': messages.length
                },
                resource: testTopic,
                error: 0
              })

              await sendMessages(kafka, testTopic, messages)

              return expectedSpanPromise
            })

            it('should be instrumented w/ error', async () => {
              let error

              const expectedSpanPromise = agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                expect(span).to.include({
                  name: expectedSchema.send.opName,
                  service: expectedSchema.send.serviceName,
                  resource: testTopic,
                  error: 1
                })

                expect(span.meta).to.include({
                  [ERROR_TYPE]: error.name,
                  [ERROR_MESSAGE]: error.message,
                  [ERROR_STACK]: error.stack,
                  component: 'confluentinc-kafka-javascript'
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
                kafkaJS: { groupId, fromBeginning: true, autoCommit: false }
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
                  'messaging.destination.name': testTopic
                },
                resource: testTopic,
                error: 0,
                type: 'worker'
              })

              const consumerReceiveMessagePromise = new Promise(resolve => {
                consumer.run({
                  eachMessage: () => {
                    resolve()
                  }
                })
              })
              await sendMessages(kafka, testTopic, messages).then(
                async () => await consumerReceiveMessagePromise
              )
              return expectedSpanPromise
            })

            it('should run the consumer in the context of the consumer span', done => {
              const firstSpan = tracer.scope().active()
              let consumerReceiveMessagePromise
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
                .then(() => consumerReceiveMessagePromise)
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
              }, { timeoutMs: 10000 })

              let consumerReceiveMessagePromise
              await consumer.run({
                eachMessage: async () => {
                  consumerReceiveMessagePromise = Promise.resolve()
                }
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
                  'messaging.destination.name': testTopic
                },
                resource: testTopic,
                error: 1,
                type: 'worker'
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
              dr_cb: true
            })

            await new Promise((resolve, reject) => {
              nativeProducer.connect({}, (err) => {
                if (err) {
                  return reject(err)
                }
                resolve()
              })
            })
          })

          afterEach(async () => {
            await new Promise((resolve, reject) => {
              nativeProducer.disconnect((err) => {
                if (err) {
                  return reject(err)
                }
                resolve()
              })
            })
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
                  'messaging.kafka.bootstrap.servers': '127.0.0.1:9092'
                },
                resource: testTopic,
                error: 0
              })

              const message = Buffer.from('test message')
              const key = 'native-key'

              nativeProducer.produce(testTopic, null, message, key)

              return expectedSpanPromise
            })

            it('should be instrumented with error', async () => {
              const expectedSpanPromise = agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                expect(span).to.include({
                  name: expectedSchema.send.opName,
                  service: expectedSchema.send.serviceName,
                  error: 1
                })

                expect(span.meta).to.include({
                  component: 'confluentinc-kafka-javascript'
                })

                expect(span.meta[ERROR_TYPE]).to.exist
                expect(span.meta[ERROR_MESSAGE]).to.exist
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
                'auto.offset.reset': 'earliest'
              })

              await new Promise((resolve, reject) => {
                nativeConsumer.connect({}, (err) => {
                  if (err) {
                    return reject(err)
                  }
                  resolve()
                })
              })
            })

            afterEach(async () => {
              await nativeConsumer.unsubscribe()
              await new Promise((resolve, reject) => {
                nativeConsumer.disconnect((err) => {
                  if (err) {
                    return reject(err)
                  }
                  resolve()
                })
              })
            })

            function consume (consumer, producer, topic, message, timeoutMs = 9500) {
              return new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                  reject(new Error(`Timeout: Did not consume message on topic "${topic}" within ${timeoutMs}ms`))
                }, timeoutMs)

                function doConsume () {
                  consumer.consume(1, function (err, messages) {
                    if (err) {
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
              })
            }

            it('should be instrumented', async () => {
              const expectedSpanPromise = expectSpanWithDefaults({
                name: expectedSchema.receive.opName,
                service: expectedSchema.receive.serviceName,
                meta: {
                  'span.kind': 'consumer',
                  component: 'confluentinc-kafka-javascript',
                  'messaging.destination.name': testTopic
                },
                resource: testTopic,
                error: 0,
                type: 'worker'
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

                expect(span).to.include({
                  name: 'kafka.consume',
                  service: 'test-kafka',
                  resource: testTopic
                })

                expect(parseInt(span.parent_id.toString())).to.be.gt(0)
              }, { timeoutMs: 10000 })
              nativeConsumer.setDefaultConsumeTimeout(10)
              nativeConsumer.subscribe([testTopic])

              // Send a test message using the producer
              const message = Buffer.from('test message propagation for native consumer 1')

              await consume(nativeConsumer, nativeProducer, testTopic, message)

              return expectedSpanPromise
            })

            // TODO: Fix this test case, fails with 'done() called multiple times'
            // it('should be instrumented with error', async () => {
            //   const fakeError = new Error('Oh No!')

            //   const expectedSpanPromise = agent.assertSomeTraces(traces => {
            //     const errorSpans = traces[0].filter(span => span.error === 1)
            //     expect(errorSpans.length).to.be.at.least(1)

            //     const errorSpan = errorSpans[0]
            //     expect(errorSpan).to.exist
            //     expect(errorSpan.name).to.equal(expectedSchema.receive.opName)
            //     expect(errorSpan.meta).to.include({
            //       component: 'confluentinc-kafka-javascript'
            //     })

            //     expect(errorSpan.meta[ERROR_TYPE]).to.equal(fakeError.name)
            //     expect(errorSpan.meta[ERROR_MESSAGE]).to.equal(fakeError.message)
            //   })

            //   nativeConsumer.consume(1, (err, messages) => {
            //     // Ensure we resolve before throwing
            //     throw fakeError
            //   })

            //   return expectedSpanPromise
            // })
          })
        })

        describe('data stream monitoring', () => {
          let consumer
          let expectedProducerHash
          let expectedConsumerHash

          beforeEach(async () => {
            tracer.init()
            tracer.use('confluentinc-kafka-javascript', { dsmEnabled: true })
            messages = [{ key: 'key1', value: 'test2' }]
            consumer = kafka.consumer({
              kafkaJS: { groupId, fromBeginning: true }
            })
            await consumer.connect()
            await consumer.subscribe({ topic: testTopic })
          })

          beforeEach(() => {
            expectedProducerHash = getDsmPathwayHash(testTopic, true, ENTRY_PARENT_HASH)
            expectedConsumerHash = getDsmPathwayHash(testTopic, false, expectedProducerHash)
          })

          afterEach(async () => {
            await consumer.disconnect()
          })

          describe('checkpoints', () => {
            let setDataStreamsContextSpy

            beforeEach(() => {
              setDataStreamsContextSpy = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
            })

            afterEach(async () => {
              setDataStreamsContextSpy.restore()
            })

            it('Should set a checkpoint on produce', async () => {
              const messages = [{ key: 'consumerDSM1', value: 'test2' }]
              await sendMessages(kafka, testTopic, messages)
              expect(setDataStreamsContextSpy.args[0][0].hash).to.equal(expectedProducerHash)
            })

            it('Should set a checkpoint on consume (eachMessage)', async () => {
              const runArgs = []
              let consumerReceiveMessagePromise
              await consumer.run({
                eachMessage: async () => {
                  runArgs.push(setDataStreamsContextSpy.lastCall.args[0])
                  consumerReceiveMessagePromise = Promise.resolve()
                }
              })
              await sendMessages(kafka, testTopic, messages).then(
                async () => await consumerReceiveMessagePromise
              )

              for (const runArg of runArgs) {
                expect(runArg.hash).to.equal(expectedConsumerHash)
              }
            })

            it('Should set a checkpoint on consume (eachBatch)', async () => {
              const runArgs = []
              let consumerReceiveMessagePromise
              await consumer.run({
                eachBatch: async () => {
                  runArgs.push(setDataStreamsContextSpy.lastCall.args[0])
                  consumerReceiveMessagePromise = Promise.resolve()
                }
              })
              await sendMessages(kafka, testTopic, messages).then(
                async () => await consumerReceiveMessagePromise
              )
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
              let consumerReceiveMessagePromise
              await consumer.run({
                eachMessage: async () => {
                  expect(recordCheckpointSpy.args[0][0].hasOwnProperty('payloadSize'))
                  recordCheckpointSpy.restore()
                  consumerReceiveMessagePromise = Promise.resolve()
                }
              })
              await sendMessages(kafka, testTopic, messages).then(
                async () => await consumerReceiveMessagePromise
              )
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

            it('Should add backlog on consumer explicit commit', async () => {
              // Send a message, consume it, and record the last consumed offset
              let commitMeta

              let messageProcessedResolve
              const messageProcessedPromise = new Promise(resolve => {
                messageProcessedResolve = resolve
              })

              const consumerRunPromise = consumer.run({
                eachMessage: async payload => {
                  const { topic, partition, message } = payload
                  commitMeta = {
                    topic,
                    partition,
                    offset: Number(message.offset)
                  }
                  messageProcessedResolve()
                }
              })

              await consumerRunPromise

              // wait for the message to be processed before continuing
              await sendMessages(kafka, testTopic, messages)
              await messageProcessedPromise
              await consumer.disconnect()

              for (const call of setOffsetSpy.getCalls()) {
                expect(call.args[0]).to.not.have.property('type', 'kafka_commit')
              }

              const newConsumer = kafka.consumer({
                kafkaJS: { groupId, fromBeginning: true, autoCommit: false }
              })
              await newConsumer.connect()
              await sendMessages(kafka, testTopic, [{ key: 'key1', value: 'test2' }])
              await newConsumer.run({
                eachMessage: async () => {
                  await newConsumer.disconnect()
                }
              })
              setOffsetSpy.resetHistory()
              await newConsumer.commitOffsets()

              // Check our work
              const runArg = setOffsetSpy.lastCall.args[0]
              expect(runArg).to.have.property('offset', commitMeta.offset)
              expect(runArg).to.have.property('partition', commitMeta.partition)
              expect(runArg).to.have.property('topic', commitMeta.topic)
              expect(runArg).to.have.property('type', 'kafka_commit')
              expect(runArg).to.have.property('consumer_group', groupId)
            })

            it('Should add backlog on producer response', async () => {
              await sendMessages(kafka, testTopic, messages)
              expect(setOffsetSpy).to.be.calledOnce
              const { topic } = setOffsetSpy.lastCall.args[0]
              expect(topic).to.equal(testTopic)
            })
          })

          describe('when using a kafka broker version that does not support message headers', () => {
            class KafkaJSError extends Error {
              constructor (message) {
                super(message)
                this.name = 'KafkaJSError'
                this.type = 'ERR_UNKNOWN'
              }
            }
            let error
            let producer
            let produceStub

            beforeEach(async () => {
              // simulate a kafka error for the broker version not supporting message headers
              error = new KafkaJSError()
              error.message = 'Simulated KafkaJSError ERR_UNKNOWN from Producer.produce stub'
              producer = kafka.producer()
              await producer.connect()

              // Spy on the produce method from the native library before it gets wrapped
              produceStub = sinon.stub(nativeApi.Producer.prototype, 'produce')
                .callsFake((topic, partition, message, key) => {
                  throw error
                })
            })

            afterEach(async () => {
              produceStub.restore()
              await producer.disconnect()
            })

            it('should hit an error for the first send and not inject headers in later sends', async () => {
              const testMessages = [{ key: 'key1', value: 'test1' }]
              const testMessages2 = [{ key: 'key2', value: 'test2' }]

              try {
                await producer.send({ topic: testTopic, messages: testMessages })
                expect.fail('First producer.send() should have thrown an error')
              } catch (e) {
                expect(e).to.equal(error)
              }
              // Verify headers were injected in the first attempt
              expect(testMessages[0].headers[0]).to.have.property('x-datadog-trace-id')

              // restore the stub to allow the next send to succeed
              produceStub.restore()

              const result = await producer.send({ topic: testTopic, messages: testMessages2 })
              expect(testMessages2[0].headers).to.be.null
              expect(result).to.not.be.undefined
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
  return expectSomeSpan(agent, expected, 10000)
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
