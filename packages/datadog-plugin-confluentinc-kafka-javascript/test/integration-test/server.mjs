import 'dd-trace/init.js'
import kafkaLib from '@confluentinc/kafka-javascript'
const { Kafka } = kafkaLib.KafkaJS

const kafka = new Kafka({
  kafkaJS: {
    clientId: 'my-app',
    brokers: ['127.0.0.1:9092'],
  },
})

const sendMessage = async (topic, messages) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const producer = kafka.producer()
      await producer.connect()
      await producer.send({ topic, messages })
      await producer.disconnect()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
}

await sendMessage('test-topic', [{ key: 'key1', value: 'test2' }])
