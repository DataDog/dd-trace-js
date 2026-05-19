import 'dd-trace/init.js'
import kafkaLib from '@confluentinc/kafka-javascript'
const { Kafka } = kafkaLib.KafkaJS

const kafka = new Kafka({
  kafkaJS: {
    clientId: 'my-app',
    brokers: ['127.0.0.1:9092'],
  },
})

async function waitForTopicReady (admin, topic, timeoutMs = 20000) {
  if (typeof admin?.fetchTopicMetadata !== 'function') return
  const start = Date.now()
  while ((Date.now() - start) < timeoutMs) {
    try {
      const meta = await admin.fetchTopicMetadata({ topics: [topic], timeout: 1000 })
      const topicMeta = Array.isArray(meta) ? meta[0] : meta?.topics?.[0]
      const partitions = topicMeta?.partitions
      if (Array.isArray(partitions) && partitions.length > 0 &&
          partitions.every(p => typeof p.leader === 'number' && p.leader >= 0)) {
        return
      }
    } catch {
      // transient — topic not yet visible
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timeout: topic "${topic}" not ready within ${timeoutMs}ms`)
}

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
