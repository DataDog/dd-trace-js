import 'dd-trace/init.js'
import { Queue, Worker, QueueEvents } from 'bullmq'

const connection = {
  host: '127.0.0.1',
  port: 6379
}

const queueName = 'esm-test-worker-process'

// Create worker first and wait for it to be ready before creating the queue
// This ensures the worker is listening before any jobs are added
const worker = new Worker(queueName, async (job) => {
  return { processed: true, jobId: job.id }
}, { connection })

await worker.waitUntilReady()

const queue = new Queue(queueName, { connection })
await queue.waitUntilReady()

const queueEvents = new QueueEvents(queueName, { connection })
await queueEvents.waitUntilReady()

// Add job and wait for processing to complete
const job = await queue.add('process-test-job', { message: 'Test job for worker processing' })
await job.waitUntilFinished(queueEvents)

await worker.close()
await queue.close()
await queueEvents.close()
