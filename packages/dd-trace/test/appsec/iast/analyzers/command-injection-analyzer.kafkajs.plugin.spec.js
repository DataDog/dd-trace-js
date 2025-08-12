'use strict'

const { testOutsideRequestHasVulnerability } = require('../utils')
const { withVersions } = require('../../../setup/mocha')

const topic = 'test-topic'

describe('command-injection-analyzer with kafkajs', () => {
  withVersions('kafkajs', 'kafkajs', version => {
    let kafka
    let consumer
    let producer

    afterEach(async function () {
      this.timeout(20000)
      await consumer?.disconnect()
      await producer?.disconnect()
    })

    describe('outside request', () => {
      testOutsideRequestHasVulnerability(async () => {
        const lib = require(`../../../../../../versions/kafkajs@${version}`).get()
        const Kafka = lib.Kafka

        kafka = new Kafka({
          clientId: 'my-app',
          brokers: ['127.0.0.1:9092']
        })

        consumer = await kafka.consumer({ groupId: 'iast-test' })
        producer = await kafka.producer()

        await consumer.connect()
        await consumer.subscribe({ topic, fromBeginning: false })

        await producer.connect()

        await consumer.run({
          eachMessage: ({ topic, message }) => {
            try {
              const { execSync } = require('child_process')

              const command = message.value.toString()
              execSync(command)
            } catch (e) {
              // do nothing
            }
          }
        })

        const sendMessage = async (topic, messages) => {
          await producer.send({
            topic,
            messages
          })
        }

        await sendMessage(topic, [{ key: 'key1', value: 'ls -la' }])
      }, 'COMMAND_INJECTION', 'kafkajs', 20000)
    })
  })
})
