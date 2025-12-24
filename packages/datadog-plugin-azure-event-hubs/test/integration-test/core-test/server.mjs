import 'dd-trace/init.js'
import { EventHubProducerClient } from '@azure/event-hubs'

const connectionString = 'Endpoint=sb://127.0.0.1:5673;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;'
const eventHubName = 'eh1'

const producer = new EventHubProducerClient(connectionString, eventHubName)

const eventData = [
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

// List of eventData
await producer.sendBatch(eventData)
// List of AMPQ messages
await producer.sendBatch(amqpMessages)

// Batch -> EventDataBatchImpl
const eventDataBatch = await producer.createBatch()
eventData.forEach((event) => {
  eventDataBatch.tryAdd(event)
})

await producer.sendBatch(eventDataBatch)
await producer.close()
