import 'dd-trace/init.js'
import { ServiceBusClient } from '@azure/service-bus'

const connectionString = 'Endpoint=sb://127.0.0.1;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;'
const queueName = 'queue.1'
const topicName = 'topic.1'

const client = new ServiceBusClient(connectionString)

const sender1 = client.createSender(queueName)
const sender2 = client.createSender(topicName)

const message = {
  body: 'Hello Datadog!'
}

const messages = [
  { body: 'Hello Datadog!' },
  { body: 'Hello Azure!' }
]

const amqpMessages = [
  {
    body: 'Hello from an amqp message',
    annotations: {
      'x-opt-custom-annotation-key': 'custom-value', // Custom annotation
      'x-opt-partition-key': 'myPartitionKey' // Example of a common annotation
    },
  },
  {
    body: 'Hello from an amqp message 2 ',
    annotations: {
      'x-opt-custom-annotation-key': 'custom-value-2', // Custom annotation
      'x-opt-partition-key': 'myPartitionKey-2' // Example of a common annotation
    }
  }
]

// queue
await sender1.sendMessages(message)
await sender1.sendMessages(messages)
await sender1.sendMessages(amqpMessages)

// topic
await sender2.sendMessages(message)
await sender2.sendMessages(messages)
await sender2.sendMessages(amqpMessages)

// scheduled messages
const scheduledEnqueueTimeUtc = new Date(Date.now() + 100)
await sender1.scheduleMessages(message, scheduledEnqueueTimeUtc)
await sender1.scheduleMessages(messages, scheduledEnqueueTimeUtc)
await sender1.scheduleMessages(amqpMessages, scheduledEnqueueTimeUtc)

// queue batching
const batch1 = await sender1.createMessageBatch()
await batch1.tryAddMessage(messages[0])
await batch1.tryAddMessage(messages[1])
await sender1.sendMessages(batch1)

// topic batching
const batch2 = await sender2.createMessageBatch()
await batch2.tryAddMessage(messages[0])
await batch2.tryAddMessage(messages[1])
await sender2.sendMessages(batch2)

await sender1.close()
await sender2.close()

await client.close()
