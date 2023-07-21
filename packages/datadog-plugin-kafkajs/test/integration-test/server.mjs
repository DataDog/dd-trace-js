import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import { Kafka } from 'kafkajs'

pluginHelpers.onMessage(async () => {
  const k = new Kafka({
    clientId: 'my-app-producer-esm-test',
    brokers: ['localhost:9092']
  })

  const producer = k.producer()
  await producer.connect()

  await producer.send({
    topic: 'test-topic',
    messages: [
      { value: 'test kafka producer' }
    ]
  })

  await producer.disconnect()
})
