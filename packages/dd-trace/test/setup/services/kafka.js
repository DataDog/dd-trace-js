'use strict'

const RetryOperation = require('../operation')

let kafka
let adminConnectAndCreateTopic
let runConsumer

const topic = 'test-topic'
const messages = [{ key: 'setup', value: 'test' }]

try {
  const Kafka = require('../../../../../versions/kafkajs').get().Kafka
  console.log('Using kafkajs')
  kafka = new Kafka({
    clientId: 'setup-client',
    brokers: ['127.0.0.1:9092']
  })

  adminConnectAndCreateTopic = async () => {
    const admin = kafka.admin()
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
  }

  runConsumer = async (topic, resolve) => {
    const consumer = kafka.consumer({ groupId: 'test-group' })
    await consumer.connect()
    await consumer.subscribe({ topic, fromBeginning: true })
    await consumer.run({
      eachMessage: () => {
        setTimeout(async () => {
          await consumer.disconnect()
          resolve()
        }, 1000)
      }
    })
  }
} catch (e) {
  // retry with the other kafka package
  console.log('Retrying with the other kafka package')
  const Kafka = require('../../../../../versions/@confluentinc/kafka-javascript@1.0.0').get().KafkaJS.Kafka
  kafka = new Kafka({
    kafkaJS: {
      clientId: 'setup-client',
      brokers: ['127.0.0.1:9092']
    }
  })

  adminConnectAndCreateTopic = async (topic) => {
    const admin = kafka.admin()
    await admin.connect()
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
  }

  runConsumer = async (topic, resolve) => {
    const consumer = kafka.consumer({ kafkaJS: { groupId: 'test-group' } })
    await consumer.connect()
    console.log(topic)
    await consumer.subscribe({ topic })
    await consumer.run({
      eachMessage: () => {
        console.log('received message')
        setTimeout(async () => {
          await consumer.disconnect()
          resolve()
        }, 1000)
      }
    })
  }
}

const runProducer = async (topic) => {
  const producer = kafka.producer()
  await producer.connect()
  await producer.send({
    topic,
    messages
  }).then(() => {
    console.log('sent message')
  })
}

function waitForKafka () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('kafka')
    operation.attempt(async currentAttempt => {
      try {
        await adminConnectAndCreateTopic(topic)
        await runConsumer(topic, resolve)
        await runProducer(topic)
      } catch (error) {
        if (operation.retry(error)) return
        return reject(error)
      }
    })
  })
}

module.exports = waitForKafka
