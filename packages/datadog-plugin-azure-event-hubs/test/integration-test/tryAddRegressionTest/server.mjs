import 'dd-trace/init.js'
import { EventHubProducerClient } from '@azure/event-hubs'

const connectionString = 'Endpoint=sb://127.0.0.1:5673;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;'
const eventHubName = 'eh1'

const producer = new EventHubProducerClient(connectionString, eventHubName)

const events = [
  { body: 'Test event 1' },
  { body: 'Test event 2' },
]

// Test that tryAdd returns a boolean, not a Promise
const batch = await producer.createBatch()

const result1 = batch.tryAdd(events[0])
const result2 = batch.tryAdd(events[1])

// Verify the return types - throw error if not correct
if (typeof result1 !== 'boolean') {
  throw new Error(`tryAdd should return a boolean, but returned ${typeof result1}`)
}

if (result1 instanceof Promise) {
  throw new Error('tryAdd should not return a Promise')
}

if (typeof result2 !== 'boolean') {
  throw new Error(`tryAdd should return a boolean, but returned ${typeof result2}`)
}

if (result2 instanceof Promise) {
  throw new Error('tryAdd should not return a Promise')
}

// Verify the values are correct
if (result1 !== true) {
  throw new Error(`Expected first tryAdd to return true, got ${result1}`)
}

if (result2 !== true) {
  throw new Error(`Expected second tryAdd to return true, got ${result2}`)
}

// Send the batch to complete the operation
await producer.sendBatch(batch)

await producer.close()
