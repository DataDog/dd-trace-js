'use strict'

const RetryOperation = require('../operation')

let kafka
let consumer
let admin
let adminConnect
let subscribe

try {
  const Kafka = require('../../../../../versions/kafkajs').get().Kafka
  kafka = new Kafka({
    clientId: 'setup-client',
    brokers: ['127.0.0.1:9092']
  })
  consumer = kafka.consumer(
    { groupId: 'test-group' }
  )
  subscribe = async (topic) => {
    await consumer.subscribe({ topic, fromBeginning: true })
  }
  admin = kafka.admin()
  adminConnect = async () => { }
} catch (e) {
  const Kafka = require('../../../../../versions/@confluentinc/kafka-javascript').get().KafkaJS.Kafka
  kafka = new Kafka({
    kafkaJS: {
      clientId: 'setup-client',
      brokers: ['127.0.0.1:9092']
    }
  })
  consumer = kafka.consumer({ kafkaJS: { groupId: 'test-group' } })
  subscribe = async (topic) => {
    await consumer.subscribe({ topic })
  }

  admin = kafka.admin()
  adminConnect = async () => { await admin.connect() }
}

const producer = kafka.producer()
const topic = 'test-topic'
const messages = [{ key: 'setup', value: 'test' }]

function waitForKafka () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('kafka')
    operation.attempt(async currentAttempt => {
      try {
        await adminConnect()
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
        await subscribe(topic)
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
