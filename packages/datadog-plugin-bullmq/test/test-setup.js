'use strict'

class BullmqTestSetup {
  async setup (module) {
    const connection = {
      host: '127.0.0.1',
      port: 6379
    }

    this.queue = new module.Queue('test-queue', { connection })
    this.flowProducer = new module.FlowProducer({ connection })
    this.queueEvents = new module.QueueEvents('test-queue', { connection })
    this.worker = new module.Worker('test-queue', async (job) => {
      if (job.data.shouldFail) {
        throw new Error('Intentional job failure for testing')
      }
      return { processed: true, jobId: job.id }
    }, { connection })

    await this.worker.waitUntilReady()
    await this.queue.waitUntilReady()
    await this.queueEvents.waitUntilReady()
  }

  async teardown () {
    if (this.worker) {
      await this.worker.close()
    }
    if (this.queue) {
      await this.queue.close()
    }
    if (this.flowProducer) {
      await this.flowProducer.close()
    }
    if (this.queueEvents) {
      await this.queueEvents.close()
    }
  }

  async queueAdd () {
    const job = await this.queue.add('test-job', {
      message: 'Hello from BullMQ',
      timestamp: Date.now()
    })
    return job
  }

  async queueAddError () {
    await this.queue.add('error-job', { data: 'test' }, {
      repeat: { pattern: 'invalid-cron-pattern' }
    })
  }

  async queueAddBulk () {
    const jobs = await this.queue.addBulk([
      { name: 'bulk-job-1', data: { message: 'First bulk job' } },
      { name: 'bulk-job-2', data: { message: 'Second bulk job' } },
      { name: 'bulk-job-3', data: { message: 'Third bulk job' } }
    ])
    return jobs
  }

  async queueAddBulkError () {
    await this.queue.addBulk([
      { name: 'valid-job', data: { ok: true } },
      { name: null, data: null, opts: { invalid: true } }
    ])
  }

  async flowProducerAdd () {
    const flow = await this.flowProducer.add({
      name: 'parent-flow-job',
      queueName: 'test-queue',
      data: { type: 'parent', message: 'I am the parent' },
      children: [
        {
          name: 'child-job-1',
          queueName: 'test-queue',
          data: { type: 'child', message: 'I am child 1' }
        },
        {
          name: 'child-job-2',
          queueName: 'test-queue',
          data: { type: 'child', message: 'I am child 2' }
        }
      ]
    })
    return flow
  }

  async flowProducerAddError () {
    // Pass circular reference to trigger JSON serialization error
    const circularData = { test: true }
    circularData.self = circularData
    await this.flowProducer.add({
      name: 'invalid-flow',
      queueName: 'test-queue',
      data: circularData
    })
  }

  async workerProcessJob () {
    const job = await this.queue.add('process-test-job', {
      message: 'Test job for worker processing'
    })
    await job.waitUntilFinished(this.queueEvents)
  }

  async workerProcessJobError () {
    const job = await this.queue.add('error-test-job', {
      shouldFail: true
    })
    await job.waitUntilFinished(this.queueEvents).catch(() => {})
  }

  async workerProcessJobBulk () {
    const jobs = await this.queue.addBulk([
      { name: 'bulk-process-job-1', data: { message: 'First bulk job for processing' } },
      { name: 'bulk-process-job-2', data: { message: 'Second bulk job for processing' } }
    ])
    await jobs[0].waitUntilFinished(this.queueEvents)
  }
}

module.exports = BullmqTestSetup
