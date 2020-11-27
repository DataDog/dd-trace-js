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
    afterEach(() => {
      agent.close()
      agent.wipe()
    })
    withVersions(plugin, 'kafkajs', (version) => {
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
            brokers: [`${process.env.HOST_IP}:9092`]
          })
        })
        describe('producer', () => {
          const topic = 'topic-test'
          const messages = [{ key: 'key1', value: 'test2' }, { key: 'key2', value: 'test2' }]

          it('should be instrumented', async () => {
            const producer = kafka.producer()
            try {
              const expectedSpanPromise = expectSpanWithDefaults({
                name: 'kafka.producer.send',
                service: 'test-kafka',
                meta: {
                  'span.kind': 'producer',
                  'component': 'kafka'
                },
                metrics: {
                  'kafka.batch.size': messages.length
                },
                resource: `produce to ${topic}`,
                error: 0
              })

              await producer.connect()
              await producer.send({
                topic,
                messages
              })
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
              topic,
              messages: [{ key: 'key1', value: 'test' }]
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
