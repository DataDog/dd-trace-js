'use strict'

const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const namingSchema = require('./naming')
const { getDataStreamsContext } = require('../../dd-trace/src/data_streams_context')

describe('Plugin', () => {
  describe('kafkajs', function () {
    this.timeout(10000) // TODO: remove when new internal trace has landed
    afterEach(() => {
      return agent.close({ ritmReset: false })
    })
    withVersions('kafkajs', 'kafkajs', (version) => {
      const testTopic = 'test-topic'
      let kafka
      let tracer
      describe('without configuration', () => {
        beforeEach(async () => {
          tracer = require('../../dd-trace')
          await agent.load('kafkajs')
          const {
            Kafka
          } = require(`../../../versions/kafkajs@${version}`).get()
          kafka = new Kafka({
            clientId: `kafkajs-test-${version}`,
            brokers: ['127.0.0.1:9092']
          })
        })
        describe('producer', () => {
          it('should be instrumented', async () => {
            const messages = [{ key: 'producer1', value: 'test2' }]
            const expectedSpanPromise = expectSpanWithDefaults({
              name: namingSchema.send.opName,
              service: namingSchema.send.serviceName,
              meta: {
                'span.kind': 'producer',
                'component': 'kafkajs'
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
            const producer = kafka.producer()
            const resourceName = namingSchema.send.opName

            let error

            const expectedSpanPromise = agent.use(traces => {
              const span = traces[0][0]

              expect(span).to.include({
                name: resourceName,
                service: namingSchema.send.serviceName,
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

          const messages = [{ key: 'producer1', value: 'test2' }]
          withNamingSchema(
            async () => sendMessages(kafka, testTopic, messages),
            () => namingSchema.send.opName,
            () => namingSchema.send.serviceName
          )
        })

        describe('producer data stream monitoring', () => {
          beforeEach(() => {
            tracer.init()
            tracer.use('kafkajs', { dsmEnabled: true })
          })
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
            const messages = [{ key: 'consumer1', value: 'test2' }]
            const expectedSpanPromise = expectSpanWithDefaults({
              name: namingSchema.receive.opName,
              service: namingSchema.receive.serviceName,
              meta: {
                'span.kind': 'consumer',
                'component': 'kafkajs'
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
            const messages = [{ key: 'consumer2', value: 'test2' }]
            const firstSpan = tracer.scope().active()
            let eachMessage = async ({ topic, partition, message }) => {
              const currentSpan = tracer.scope().active()
              try {
                expect(currentSpan).to.not.equal(firstSpan)
                expect(currentSpan.context()._name).to.equal(namingSchema.receive.opName)
                done()
              } catch (e) {
                done(e)
              } finally {
                eachMessage = () => {} // avoid being called for each message
              }
            }

            consumer.run({
              eachMessage: (...args) => eachMessage(...args) })
              .then(() => sendMessages(kafka, testTopic, messages))
              .catch(done)
          })

          it('should be instrumented w/ error', async () => {
            const messages = [{ key: 'consumer3', value: 'test2' }]
            const fakeError = new Error('Oh No!')
            const expectedSpanPromise = expectSpanWithDefaults({
              name: namingSchema.receive.opName,
              service: namingSchema.receive.serviceName,
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
            const messages = [{ key: 'consumer4', value: 'test2' }]
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

            const runResult = consumer.run({
              eachBatch: (...args) => eachBatch(...args)
            })

            if (!runResult || !runResult.then) {
              throw new Error('Consumer.run returned invalid result')
            }

            runResult
              .then(() => sendMessages(kafka, testTopic, messages))
              .catch(done)
          })

          const messages = [{ key: 'consumer4', value: 'test2' }]
          withNamingSchema(
            async () => {
              await consumer.run({ eachMessage: () => {} })
              await sendMessages(kafka, testTopic, messages)
            },
            () => namingSchema.send.opName,
            () => namingSchema.send.serviceName
          )
        })

        describe('consumer data stream monitoring', () => {
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
            await sendMessages(kafka, testTopic, messages)
            const dataStreamsContext = getDataStreamsContext()
            console.log(dataStreamsContext)
          })

          it('Should set a checkpoint on consume', (done) => {
            consumer.run({
              eachMessage: async ({ topic, partition, message, heartbeat, pause }) => {
                console.log(message)
                done()
              } })
              .catch(done)
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
