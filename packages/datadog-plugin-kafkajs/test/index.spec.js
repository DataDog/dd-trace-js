'use strict'

const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const { expectedSchema, rawExpectedSchema } = require('./naming')
const DataStreamsContext = require('../../dd-trace/src/data_streams_context')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH, DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')

const testTopic = 'test-topic'
const expectedProducerHash = computePathwayHash(
  'test',
  'tester',
  ['direction:out', 'topic:' + testTopic, 'type:kafka'],
  ENTRY_PARENT_HASH
)
const expectedConsumerHash = computePathwayHash(
  'test',
  'tester',
  ['direction:in', 'group:test-group', 'topic:' + testTopic, 'type:kafka'],
  expectedProducerHash
)

describe('Plugin', () => {
  describe('kafkajs', function () {
    this.timeout(10000) // TODO: remove when new internal trace has landed
    afterEach(() => {
      return agent.close({ ritmReset: false })
    })
    withVersions('kafkajs', 'kafkajs', (version) => {
      let kafka
      let tracer
      let Kafka
      describe('without configuration', () => {
        const messages = [{ key: 'key1', value: 'test2' }]
        beforeEach(async () => {
          process.env['DD_DATA_STREAMS_ENABLED'] = 'true'
          tracer = require('../../dd-trace')
          await agent.load('kafkajs')
          Kafka = require(`../../../versions/kafkajs@${version}`).get().Kafka

          kafka = new Kafka({
            clientId: `kafkajs-test-${version}`,
            brokers: ['127.0.0.1:9092']
          })
        })
        describe('producer', () => {
          it('should be instrumented', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.send.opName,
              service: expectedSchema.send.serviceName,
              meta: {
                'span.kind': 'producer',
                'component': 'kafkajs',
                'pathway.hash': expectedProducerHash.readBigUInt64BE(0).toString()
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

          withPeerService(
            () => tracer,
            'kafkajs',
            (done) => sendMessages(kafka, testTopic, messages).catch(done),
            '127.0.0.1:9092',
            'messaging.kafka.bootstrap.servers')

          it('should be instrumented w/ error', async () => {
            const producer = kafka.producer()
            const resourceName = expectedSchema.send.opName

            let error

            const expectedSpanPromise = agent.use(traces => {
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
                'component': 'kafkajs'
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
          if (version !== '1.4.0') {
            it('should not extract bootstrap servers when initialized with a function', async () => {
              const expectedSpanPromise = agent.use(traces => {
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

          withNamingSchema(
            async () => sendMessages(kafka, testTopic, messages),
            rawExpectedSchema.send
          )
        })
        describe('consumer', () => {
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
                'component': 'kafkajs',
                'pathway.hash': expectedConsumerHash.readBigUInt64BE(0).toString()
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
            const expectedSpanPromise = agent.use(traces => {
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
                'component': 'kafkajs'
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

          afterEach(async () => {
            await consumer.disconnect()
          })

          it('Should set a checkpoint on produce', async () => {
            const messages = [{ key: 'consumerDSM1', value: 'test2' }]
            const setDataStreamsContextSpy = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
            await sendMessages(kafka, testTopic, messages)
            expect(setDataStreamsContextSpy.args[0][0].hash).to.equal(expectedProducerHash)
            setDataStreamsContextSpy.restore()
          })

          it('Should set a checkpoint on consume', async () => {
            await sendMessages(kafka, testTopic, messages)
            const setDataStreamsContextSpy = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
            await consumer.run({
              eachMessage: async ({ topic, partition, message, heartbeat, pause }) => {
                expect(setDataStreamsContextSpy.args[0][0].hash).to.equal(expectedConsumerHash)
              }
            })
            setDataStreamsContextSpy.restore()
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
