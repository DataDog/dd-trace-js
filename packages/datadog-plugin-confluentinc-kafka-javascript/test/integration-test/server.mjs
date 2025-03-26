import 'dd-trace/init.js'
import { KafkaJS } from '@confluentinc/kafka-javascript'
const { Kafka } = KafkaJS

const kafka = new Kafka({
  kafkaJS: {
    clientId: 'my-app',
    brokers: ['127.0.0.1:9092']
  }
})

const sendMessage = async (topic, messages) => {
  try {
    const producer = kafka.producer()
    await producer.connect()
    await producer.send({
      topic,
      messages
    })
    await producer.disconnect()
  } catch (error) {
    // pass
  }
}

await sendMessage('test-topic', [{ key: 'key1', value: 'test2' }])
