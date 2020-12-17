'use strict'

const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const plugin = require('../src')

wrapIt()

const TIMEOUT = 20000

describe('Plugin', () => {
  describe('kafkajs', function () {
    this.timeout(TIMEOUT)
    afterEach(() => {
      agent.close()
      agent.wipe()
    })
    withVersions(plugin, 'kafkajs', (version) => {
      const testTopic = 'topic-test-1'
      let kafka
      let tracer
      describe('without configuration', () => {
        const messages = [{ key: 'key1', value: 'test2' }]
        beforeEach(async () => {
          tracer = require('../../dd-trace')
          agent.load('kafkajs')
          const {
            Kafka
          } = require(`../../../versions/kafkajs@${version}`).get()
          kafka = new Kafka({
            clientId: `kafkajs-test-${version}`,
            brokers: [`localhost:9092`]
          })
        })
        describe('producer', () => {
          it('should be instrumented', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: 'kafka.produce',
              service: 'test-kafka',
              meta: {
                'span.kind': 'producer',
                'component': 'kafka'
              },
              metrics: {
                'kafka.batch.size': messages.length
              },
              resource: testTopic,
              error: 0,
              type: 'queue'

            })

            await sendMessages(kafka, testTopic, messages)
            // Useful to debug trace
            // agent.use(traces => console.log(traces[0]))

            return expectedSpanPromise
          })
          it('should propagate context', async () => {
            const firstSpan = tracer.scope().active()
            await sendMessages(kafka, testTopic, messages)

            return expect(tracer.scope().active()).to.equal(firstSpan)
          })
        })
        describe('consumer', () => {
          let consumer
          beforeEach(async () => {
            consumer = kafka.consumer({ groupId: `test-group-${version}-${Math.random()}` })
            await consumer.connect()
            await consumer.subscribe({ topic: testTopic })
            await sendMessages(kafka, testTopic, messages)
          })

          afterEach(async () => {
            await consumer.disconnect()
          })
          it('should be instrumented', async () => {
            // We are changing the groupId in every test so the consumed offset is always reset

            const expectedSpanPromise = expectSpanWithDefaults({
              name: 'kafka.consume',
              service: 'test-kafka',
              meta: {
                'span.kind': 'consumer',
                'component': 'kafka'
              },
              resource: testTopic,
              error: 0,
              type: 'queue'
            })

            await consumer.run({
              eachMessage: async ({ topic, partition, message }) => {

              }
            })
            await sendMessages(kafka, testTopic, messages)

            // Sometimes there is a race condition where the Span that is active when the test returns
            // is the one after producing the messages, we are using this sleep function to minimize that from happening
            await sleep(200)
            return expectedSpanPromise
          })
          it('should propagate context', async () => {
            const consumer = kafka.consumer({ groupId: `test-group-${version}-propagate` })
            const firstSpan = tracer.scope().active()

            await consumer.run({
              eachMessage: async ({ topic, partition, message }) => {}
            })

            return expect(tracer.scope().active()).to.equal(firstSpan)
          })

          it('should be instrumented w/ error', async () => {
            const fakeError = new Error('Oh No!')
            const expectedSpanPromise = expectSpanWithDefaults({
              name: 'kafka.consume',
              service: 'test-kafka',
              meta: {
                'span.kind': 'consumer',
                'component': 'kafka',
                'error.type': 'Error',
                'error.msg': fakeError.message
              },
              resource: testTopic,
              error: 1,
              type: 'queue'

            })

            await consumer.subscribe({ topic: testTopic, fromBeginning: true })
            await consumer.run({
              eachMessage: async ({ topic, partition, message }) => {
                throw fakeError
              }
            })

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
  return expectSomeSpan(agent, expected, { timeoutMs: TIMEOUT })
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

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
