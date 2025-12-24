import 'dd-trace/init.js'
import { EventHubProducerClient } from '@azure/event-hubs'

const connectionString = 'Endpoint=sb://127.0.0.1:5673;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;'
const eventHubName = 'eh1'

const producer = new EventHubProducerClient(connectionString, eventHubName)

const events = [
  { body: 'Test event 1' },
  { body: 'Test event 2' }
]

// Test that tryAdd returns a boolean, not a Promise
const batch = await producer.createBatch()

batch.tryAdd(events[0])
batch.tryAdd(events[1])

if (batch._spanContexts.length !== 0) {
  throw new Error(
    "We should not be using Azure's eventDataBatchspan context. Please use the weak map instead."
  )
}

// Send the batch to complete the operation
await producer.sendBatch(batch)

await producer.close()
