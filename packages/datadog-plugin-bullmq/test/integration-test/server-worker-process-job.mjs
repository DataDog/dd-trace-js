import 'dd-trace/init.js'
import { Queue, Worker } from 'bullmq'

const connection = {
  host: '127.0.0.1',
  port: 6379
}

const queueName = 'esm-test-worker-process'

const queue = new Queue(queueName, { connection })

// Create a promise that resolves when the worker processes the job
let resolveJobProcessed
const jobProcessed = new Promise(resolve => {
  resolveJobProcessed = resolve
})

const worker = new Worker(queueName, async (job) => {
  const result = { processed: true, jobId: job.id }
  resolveJobProcessed(result)
  return result
}, { connection })

await worker.waitUntilReady()
await queue.waitUntilReady()

// Test Worker.callProcessJob() - tests Worker_callProcessJob channel
// Adding a job and waiting for it to be processed by the worker
await queue.add('process-test-job', { message: 'Test job for worker processing' })
await jobProcessed

await worker.close()
await queue.close()