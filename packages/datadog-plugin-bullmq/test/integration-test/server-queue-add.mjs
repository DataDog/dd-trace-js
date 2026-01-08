import 'dd-trace/init.js'
import { Queue } from 'bullmq'

const connection = {
  host: '127.0.0.1',
  port: 6379
}

const queueName = 'esm-test-queue-add'

const queue = new Queue(queueName, { connection })
await queue.waitUntilReady()

// Test Queue.add() - tests Queue_add channel
await queue.add('test-job', { message: 'Testing Queue.add' })

await queue.close()
