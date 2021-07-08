'use strict'

const RetryOperation = require('../operation')
const { Kafka } = require('../../../../../versions/kafkajs').get()

const kafka = new Kafka({
  clientId: 'setup-client',
  brokers: ['localhost:9092']
})
const producer = kafka.producer()
const consumer = kafka.consumer({ groupId: 'test-group' })
const topic = 'test-topic'
const messages = [{ key: 'setup', value: 'test' }]

function waitForKafka () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('kafka')
    operation.attempt(async currentAttempt => {
      try {
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
