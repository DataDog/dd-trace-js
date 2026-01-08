import 'dd-trace/init.js'
import { Queue, Worker, QueueEvents } from 'bullmq'

const connection = {
  host: '127.0.0.1',
  port: 6379
}

const queueName = 'esm-test-worker-process'

const queue = new Queue(queueName, { connection })
const queueEvents = new QueueEvents(queueName, { connection })

const worker = new Worker(queueName, async (job) => {
  return { processed: true, jobId: job.id }
}, { connection })

await worker.waitUntilReady()
await queue.waitUntilReady()
await queueEvents.waitUntilReady()

// Test Worker.callProcessJob() - tests Worker_callProcessJob channel
// Using waitUntilFinished ensures the entire job lifecycle completes,
// including the consumer span being finished and flushed
const job = await queue.add('process-test-job', { message: 'Test job for worker processing' })
await job.waitUntilFinished(queueEvents)

await worker.close()
await queue.close()
await queueEvents.close()
