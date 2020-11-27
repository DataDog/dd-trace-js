'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const plugin = require('../src')

wrapIt()

// The roundtrip to the pubsub emulator takes time. Sometimes a *long* time.
const TIMEOUT = 5000

describe('Plugin', () => {
  describe('kafkajs', function () {
    this.timeout(TIMEOUT)
    before(() => {
      process.env.KAFKA_EMULATOR_HOST = 'localhost:8085'
    })
    after(() => {
      delete process.env.KAFKA_EMULATOR_HOST
    })
    afterEach(() => {
      agent.close()
      agent.wipe()
    })
    withVersions(plugin, 'kafkajs', (version) => {
      let kafka
      describe('without configuration', () => {
        beforeEach(async () => {
          agent.load('kafkajs')
          const {
            Kafka
          } = require(`../../../versions/kafkajs@${version}`).get()
          kafka = new Kafka({
            clientId: 'kafkajs-test',
            brokers: [`${process.env.HOST_IP}:9092`]
          })
        })
        describe('producer', () => {
          it('should be instrumented', async () => {
            const topic = 'topic-test'

            const producer = kafka.producer()
            try {
              const expectedSpanPromise = expectSpanWithDefaults({
                service: 'test-kafka',
                meta: {
                  'span.kind': 'producer',
                  'component': 'kafka'
                }
              })

              await producer.connect()
              await producer.send({
                topic,
                messages: [{ key: 'key1', value: 'test' }]
              })
              // agent.use(traces => console.log(traces))

              return expectedSpanPromise
            } catch (error) {
              // console.log(error)
            }
          })
        })
      })
    })
  })
})

function expectSpanWithDefaults (expected) {
  const { service } = expected.meta
  expected = withDefaults({
    name: 'kafka.producer.send',
    service,
    meta: expected.meta
  }, expected)
  return expectSomeSpan(agent, expected, { timeoutMs: TIMEOUT })
}
