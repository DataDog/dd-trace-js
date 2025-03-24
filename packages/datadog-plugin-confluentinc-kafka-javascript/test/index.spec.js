'use strict'

const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { expectedSchema } = require('./naming')
const testTopic = 'test-topic'

describe('Plugin', () => {
  const module = '@confluentinc/kafka-javascript'

  describe('@confluentinc/kafka-javascript', function () {
    this.timeout(10000)

    afterEach(() => {
      return agent.close({ ritmReset: false })
    })

    withVersions('confluentinc-kafka-javascript', module, (version) => {
      let kafka
      let tracer
      let Kafka
      let ConfluentKafka
      let messages

      describe('without configuration', () => {
        beforeEach(async () => {
          messages = [{ key: 'key1', value: 'test2' }]

          tracer = require('../../dd-trace')
          await agent.load('@confluentinc/kafka-javascript')
          const lib = require(`../../../versions/${module}@${version}`).get()
          ConfluentKafka = lib.KafkaJS
          Kafka = ConfluentKafka.Kafka
          kafka = new Kafka({
            kafkaJS: {
              clientId: `kafkajs-test-${version}`,
              brokers: ['127.0.0.1:9092']
            }
          })
        })

        describe('producer', () => {
          it('should be instrumented', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.send.opName,
              service: expectedSchema.send.serviceName,
              meta: {
                'span.kind': 'producer',
                component: '@confluentinc/kafka-javascript',
                'messaging.destination.name': 'test-topic',
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
                component: '@confluentinc/kafka-javascript'
              })
            })

            try {
              await producer.connect()
              await producer.send({
                testTopic,
                messages: 'Oh no!' // This will cause an error because messages should be an array
              })
            } catch (e) {
              error = e
              await producer.disconnect()
              return expectedSpanPromise
            }
          })
        })

        describe('consumer (eachMessage)', () => {
          let consumer

          beforeEach(async () => {
            messages = [{ key: 'key1', value: 'test2' }]
            consumer = kafka.consumer({
              kafkaJS: { groupId: 'test-group' }
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
                component: '@confluentinc/kafka-javascript',
                'messaging.destination.name': 'test-topic'
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
                component: '@confluentinc/kafka-javascript',
                'messaging.destination.name': 'test-topic'
              },
              resource: testTopic,
              error: 1,
              type: 'worker'
            })

            const eachMessage = async ({ topic, partition, message }) => {
              throw fakeError
            }

            await consumer.run({ eachMessage })
            await sendMessages(kafka, testTopic, messages)

            return expectedSpanPromise
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
