/* eslint-disable no-console, no-unused-vars */
'use strict'

const tracer = require('dd-trace').init()
const { Queue, Worker } = require('bullmq')
const { randomUUID } = require('crypto')

const QUEUE_NAME = `test-queue-${randomUUID()}`
const CONNECTION = {
  host: 'localhost',
  port: 6379
}

class BullmqSampleApp {
  async setup () {
    console.log('Setting up sample application...')
    this.queue = new Queue(QUEUE_NAME, { connection: CONNECTION })
    this.worker = new Worker(QUEUE_NAME, async job => {
      // Simple job processing
      await new Promise(resolve => setTimeout(resolve, 100))
      return { result: `Processed job ${job.id}` }
    }, { connection: CONNECTION })

    // Wait for the worker to be ready
    await this.worker.waitUntilReady()
  }

  async teardown () {
    console.log('Tearing down sample application...')
    await this.queue.close()
    await this.worker.close()
  }

  // --- Required Operations ---

  async addJob () {
    console.log('Executing operation: addJob')
    this.lastJob = await this.queue.add('test-job', { data: 'some-data' })
  }

  async addJobError () {
    console.log('Executing operation: addJobError')
    try {
      const badQueue = new Queue(QUEUE_NAME, { connection: { port: 9999 } })
      await badQueue.add('job-that-will-fail', {})
    } catch (e) {
      // Expected error
    } finally {
      // await badQueue.close()
    }
  }

  async waitForJobCompletion () {
    console.log('Executing operation: waitForJobCompletion')
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
    console.log('Executing operation: addBulkJobs')
    await this.queue.addBulk([
      { name: 'bulk-job-1', data: {} },
      { name: 'bulk-job-2', data: {} }
    ])
  }

  async addBulkJobsError () {
    console.log('Executing operation: addBulkJobsError')
    const badQueue = new Queue(QUEUE_NAME, { connection: { port: 9999 } })
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
    console.log('Executing operation: addDelayedJob')
    await this.queue.add('delayed-job', {}, { delay: 1000 })
  }

  async addDelayedJobError () {
    console.log('Executing operation: addDelayedJobError')
    const badQueue = new Queue(QUEUE_NAME, { connection: { port: 9999 } })
    try {
      await badQueue.add('delayed-fail', {}, { delay: 1000 })
    } catch (e) {
      // Expected error
    } finally {
      await badQueue.close()
    }
  }

  async addJobWithPriority () {
    console.log('Executing operation: addJobWithPriority')
    await this.queue.add('priority-job', {}, { priority: 1 })
  }

  async addJobWithPriorityError () {
    console.log('Executing operation: addJobWithPriorityError')
    const badQueue = new Queue(QUEUE_NAME, { connection: { port: 9999 } })
    try {
      await badQueue.add('priority-fail', {}, { priority: 1 })
    } catch (e) {
      // Expected error
    } finally {
      await badQueue.close()
    }
  }
}

async function main () {
  const app = new BullmqSampleApp()
  await app.setup()
  await app.addJob()
  await app.waitForJobCompletion()
  // await app.addJobError()
  await app.addBulkJobs()
  // await app.addBulkJobsError()
  await app.addDelayedJob()
  // await app.addDelayedJobError()
  await app.addJobWithPriority()
  // await app.addJobWithPriorityError()
  await app.teardown()
}

main().catch(console.error)
