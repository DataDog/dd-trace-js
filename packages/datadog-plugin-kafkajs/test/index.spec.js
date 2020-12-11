'use strict'

const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const plugin = require('../src')

wrapIt()

const TIMEOUT = 30000

describe('Plugin', () => {
  describe('kafkajs', function () {
    this.timeout(TIMEOUT)
    afterEach(() => {
      agent.close()
      agent.wipe()
    })
    withVersions(plugin, 'kafkajs', (version) => {
      const testTopic = 'topic-test'
      let kafka
      let tracer
      describe('without configuration', () => {
        beforeEach(async () => {
          tracer = require('../../dd-trace')
          agent.load('kafkajs')
          const {
            Kafka
          } = require(`../../../versions/kafkajs@${version}`).get()
          kafka = new Kafka({
            clientId: 'kafkajs-test',
            brokers: [`localhost:9092`]
          })
        })
        describe('producer', () => {
          const messages = [{ key: 'key1', value: 'test2' }, { key: 'key2', value: 'test2' }]

          it('should be instrumented', async () => {
            const producer = kafka.producer()
            try {
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

              await producer.connect()
              await producer.send({
                topic: testTopic,
                messages
              })
              // Useful to debug trace
              // agent.use(traces => console.log(traces[0]))

              return expectedSpanPromise
            } catch (error) {
              // console.log(error)
            }
          })
          it('should propagate context', async () => {
            const producer = kafka.producer()
            const firstSpan = tracer.scope().active()
            await producer.connect()
            await producer.send({
              topic: testTopic,
              messages: [{ key: 'key1', value: 'test' }]
            })

            return expect(tracer.scope().active()).to.equal(firstSpan)
          })
        })
        describe('consumer', () => {
          it('should be instrumented', async () => {
            // We are changing the groupId in every test so the consumed offset is always reset
            const consumer = kafka.consumer({ groupId: `test-group-${version}-instrument` })
            try {
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

              await consumer.connect()
              await consumer.subscribe({ topic: testTopic, fromBeginning: true })
              await consumer.run({
                eachMessage: async ({ topic, partition, message }) => {
                  expect(topic).to.equal(testTopic)
                }
              })

              return expectedSpanPromise
            } catch (error) {
              // console.log(error)
            }
          })
          it('should propagate context', async () => {
            const consumer = kafka.consumer({ groupId: `test-group-${version}-propagate` })
            const firstSpan = tracer.scope().active()
            await consumer.connect()
            await consumer.subscribe({ topic: testTopic, fromBeginning: true })
            await consumer.run({
              eachMessage: async ({ topic, partition, message }) => {
                expect(topic).to.equal(testTopic)
              }
            })

            return expect(tracer.scope().active()).to.equal(firstSpan)
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
