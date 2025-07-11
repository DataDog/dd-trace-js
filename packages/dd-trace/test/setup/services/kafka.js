'use strict'

const RetryOperation = require('../operation')
const { Kafka } = require('../../../../../versions/kafkajs').get()

const kafka = new Kafka({
  clientId: 'setup-client',
  brokers: ['127.0.0.1:9092']
})
const admin = kafka.admin()
const producer = kafka.producer()
const consumer = kafka.consumer({ groupId: 'setup-group' })
const topic = 'test-topic'
const messages = [{ key: 'setup', value: 'test' }]

function waitForKafka () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('kafka')
    operation.attempt(async currentAttempt => {
      try {
        await admin.listTopics()
        try {
          await admin.createTopics({
            topics: [{
              topic,
              numPartitions: 1,
              replicationFactor: 1
            }]
          })
        } catch (e) {
          // Ignore since this will fail when the topic already exists.
        } finally {
          await admin.disconnect()
        }

        await consumer.connect()
        await consumer.subscribe({ topic, fromBeginning: true })
        await consumer.run({
          eachMessage: () => {
            setTimeout(async () => {
              try {
                await consumer.disconnect()
                resolve()
              } catch (e) {
                if (operation.retry(e)) return
                reject(e)
              }
            })
          }
        })

        await producer.connect()
        await producer.send({
          topic,
          messages
        })
        await producer.disconnect()
      } catch (error) {
        if (operation.retry(error)) return
        return reject(error)
      }
    })
  })
}

module.exports = waitForKafka
