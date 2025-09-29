'use strict'

const { randomUUID } = require('crypto')

class BullmqTestSetup {
  constructor () {
    this.integrationName = 'bullmq'
    this.queue = null
    this.worker = null
    this.queueName = `test-queue-${randomUUID()}`
    this.connection = {
      host: 'localhost',
      port: 6379
    }
  }

  async setup (module) {
    const { Queue, Worker } = module

    // Use modern API with connection object
    this.queue = new Queue(this.queueName, { connection: this.connection })
    this.worker = new Worker(this.queueName, async job => {
      // Simple job processing
      await new Promise(resolve => setTimeout(resolve, 100))
      return { result: `Processed job ${job.id}` }
    }, { connection: this.connection })

    await this.worker.waitUntilReady()
  }

  async teardown () {
    await this.queue.close()
    await this.worker.close()
  }

  // --- Required Operations ---

  async addJob () {
    if (!this.queue) {
      throw new Error('Queue is not initialized - setup may have failed')
    }
    this.lastJob = await this.queue.add('test-job', { data: 'some-data' })
  }

  async addJobError () {
    const { Queue } = require(`../../../versions/bullmq@${this.moduleVersion || '>=1.0.0'}`).get()
    try {
      const badQueue = this.moduleVersion && this.moduleVersion.startsWith('1.')
        ? new Queue(this.queueName, 9999, 'localhost')
        : new Queue(this.queueName, { connection: { port: 9999 } })
      await badQueue.add('job-that-will-fail', {})
    } catch (e) {
      // Expected error
    }
  }

  async waitForJobCompletion () {
    if (!this.lastJob) return

    return new Promise((resolve) => {
      const onCompleted = (job) => {
        if (job.id === this.lastJob.id) {
          this.worker.removeListener('completed', onCompleted)
          resolve()
        }
      }
      this.worker.on('completed', onCompleted)
    })
  }
  // --- Optional Operations ---

  async addBulkJobs () {
    await this.queue.addBulk([
      { name: 'bulk-job-1', data: {} },
      { name: 'bulk-job-2', data: {} }
    ])
  }

  async addBulkJobsError () {
    const badQueue = new Queue(this.queueName, { connection: { port: 9999 } })
    try {
      await badQueue.addBulk([
        { name: 'bulk-fail-1', data: {} },
        { name: 'bulk-fail-2', data: {} }
      ])
    } catch (e) {
      // Expected error
    } finally {
      await badQueue.close()
    }
  }

  async addDelayedJob () {
    await this.queue.add('delayed-job', {}, { delay: 1000 })
  }

  async addDelayedJobError () {
    const badQueue = new Queue(this.queueName, { connection: { port: 9999 } })
    try {
      await badQueue.add('delayed-fail', {}, { delay: 1000 })
    } catch (e) {
      // Expected error
    } finally {
      await badQueue.close()
    }
  }

  async addJobWithPriority () {
    await this.queue.add('priority-job', {}, { priority: 1 })
  }

  async addJobWithPriorityError () {
    const badQueue = new Queue(this.queueName, { connection: { port: 9999 } })
    try {
      await badQueue.add('priority-fail', {}, { priority: 1 })
    } catch (e) {
      // Expected error
    } finally {
      await badQueue.close()
    }
  }
}

module.exports = BullmqTestSetup
