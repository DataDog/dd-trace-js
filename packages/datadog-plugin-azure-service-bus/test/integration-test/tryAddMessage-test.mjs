import 'dd-trace/init.js'
import { ServiceBusClient } from '@azure/service-bus'

const connectionString = 'Endpoint=sb://127.0.0.1;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;'
const queueName = 'queue.1'

const client = new ServiceBusClient(connectionString)
const sender = client.createSender(queueName)

const messages = [
  { body: 'Test message 1' },
  { body: 'Test message 2' }
]

// Test that tryAddMessage returns a boolean, not a Promise
const batch = await sender.createMessageBatch()

const result1 = batch.tryAddMessage(messages[0])
const result2 = batch.tryAddMessage(messages[1])

// Verify the return types - throw error if not correct
if (typeof result1 !== 'boolean') {
  throw new Error(`tryAddMessage should return a boolean, but returned ${typeof result1}`)
}

if (result1 instanceof Promise) {
  throw new Error('tryAddMessage should not return a Promise')
}

if (typeof result2 !== 'boolean') {
  throw new Error(`tryAddMessage should return a boolean, but returned ${typeof result2}`)
}

if (result2 instanceof Promise) {
  throw new Error('tryAddMessage should not return a Promise')
}

// Verify the values are correct
if (result1 !== true) {
  throw new Error(`Expected first tryAddMessage to return true, got ${result1}`)
}

if (result2 !== true) {
  throw new Error(`Expected second tryAddMessage to return true, got ${result2}`)
}

// Send the batch to complete the operation
await sender.sendMessages(batch)

await sender.close()
await client.close()
