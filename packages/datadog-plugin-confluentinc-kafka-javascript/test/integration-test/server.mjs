import 'dd-trace/init.js'
import kafkaLib from '@confluentinc/kafka-javascript'
import helpersModule from './helpers.js'

const { waitForTopicReady } = helpersModule
const { Kafka } = kafkaLib.KafkaJS

const kafka = new Kafka({
  kafkaJS: {
    clientId: 'my-app',
    brokers: ['127.0.0.1:9092'],
  },
})

const admin = kafka.admin()
await admin.connect()
try {
  await admin.createTopics({
    topics: [{ topic: 'test-topic', numPartitions: 1, replicationFactor: 1 }],
  })
} catch (err) {
  if (err.type !== 'TOPIC_ALREADY_EXISTS') throw err
}
await waitForTopicReady(admin, 'test-topic')
await admin.disconnect()

const producer = kafka.producer()
await producer.connect()
await producer.send({ topic: 'test-topic', messages: [{ key: 'key1', value: 'test2' }] })
await producer.disconnect()
