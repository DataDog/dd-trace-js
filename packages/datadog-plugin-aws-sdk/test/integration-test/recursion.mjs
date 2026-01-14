import 'dd-trace/init.js'
import {
  SQSClient,
  CreateQueueCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs'

const client = new SQSClient({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })

// Create queue first
const createRes = await client.send(new CreateQueueCommand({ QueueName: 'test-queue' }))
const queueUrl = createRes.QueueUrl

// Send many receive message commands to trigger recursion
for (let i = 0; i < 500; i++) {
  client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MessageAttributeNames: ['.*'] }))
}
