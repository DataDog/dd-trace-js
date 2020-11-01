'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const plugin = require('../src')
const id = require('../../dd-trace/src/id')

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
      // let tracer
      describe('without configuration', () => {
        beforeEach(() => {
          // tracer = require('../../dd-trace')
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
            const expectedTags = {
              'service.name': 'kafkajsTest',
              'resource.name': 'Producer Connected',
              'span.kind': 'producer',
              'span.type': 'queue',
              component: 'kafkajs'
            }

            const producer = kafka.producer()
            await producer.connect()

            return expectSomeSpan(agent, withDefaults(expectedTags), { timeoutMs: TIMEOUT })
          })
        })
      })
    })
  })
})
