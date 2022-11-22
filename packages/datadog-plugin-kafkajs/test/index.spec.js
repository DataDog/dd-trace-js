'use strict'

const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

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
        const messages = [{ key: 'key1', value: 'test2' }]
        beforeEach(async () => {
          tracer = require('../../dd-trace')
          await agent.load('kafkajs')
          const {
            Kafka
          } = require(`../../../versions/kafkajs@${version}`).get()
          kafka = new Kafka({
            clientId: `kafkajs-test-${version}`,
            brokers: ['localhost:9092']
          })
        })
        describe('producer', () => {
          it('should be instrumented', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: 'kafka.produce',
              service: 'test-kafka',
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
            const resourceName = 'kafka.produce'

            let error

            const expectedSpanPromise = agent.use(traces => {
              const span = traces[0][0]

              expect(span).to.include({
                name: resourceName,
                service: 'test-kafka',
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
              name: 'kafka.consume',
              service: 'test-kafka',
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
            const firstSpan = tracer.scope().active()

            let eachMessage = async ({ topic, partition, message }) => {
              const currentSpan = tracer.scope().active()

              try {
                expect(currentSpan).to.not.equal(firstSpan)
                expect(currentSpan.context()._name).to.equal('kafka.consume')
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
              name: 'kafka.consume',
              service: 'test-kafka',
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
