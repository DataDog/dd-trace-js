import 'dd-trace/init.js'
import { ServiceBusClient } from '@azure/service-bus'

const connectionString = 'Endpoint=sb://127.0.0.1;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;'
const queueName = 'queue.1'

const client = new ServiceBusClient(connectionString)
const sender = client.createSender(queueName)

const message = {
  body: 'Hello Datadog!'
}

await sender.sendMessages(message)
await sender.close()
await client.close()
