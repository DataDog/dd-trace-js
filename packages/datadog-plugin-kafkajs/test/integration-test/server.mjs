import { Kafka } from 'kafkajs'

const kafka = new Kafka({
  clientId: 'my-app',
  brokers: ['127.0.0.1:9092']
})

const sendMessage = async (topic, messages) => {
  const producer = kafka.producer()
  await producer.connect()
  await producer.send({
    topic,
    messages
  })
  await producer.disconnect()
}

await sendMessage('test-topic', [{ key: 'key1', value: 'test2' }])
