import 'dd-trace/init.js'
import bullmq from 'bullmq'

const connection = {
  host: '127.0.0.1',
  port: 6379,
}

const queueName = 'esm-test-queue-add-bulk'

const queue = new bullmq.Queue(queueName, { connection })
await queue.waitUntilReady()

// Test Queue.addBulk() - tests Queue_addBulk channel
await queue.addBulk([
  { name: 'bulk-job-1', data: { message: 'First bulk job' } },
  { name: 'bulk-job-2', data: { message: 'Second bulk job' } },
])

await queue.close()
