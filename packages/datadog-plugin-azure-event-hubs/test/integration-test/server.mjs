import 'dd-trace/init.js'
import { EventHubProducerClient } from '@azure/event-hubs'

const connectionString = "Endpoint=sb://127.0.0.1;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;"
const eventHubName = 'eh1'

const producer = new EventHubProducerClient(connectionString, eventHubName)
const eventData = [
  {body: 'Hello Datadog!'},
  {body: 'Hello Azure!'}
]

await producer.sendBatch(eventData)
await producer.close()
