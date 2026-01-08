'use strict'

class BeeQueueTestSetup {
  async setup (Module) {
    this.Queue = Module
    this.queue = new Module('test-queue', {
      redis: {
        host: '127.0.0.1',
        port: 6379
      },
      isWorker: true,
      removeOnSuccess: true,
      removeOnFailure: false,
      stallInterval: 1000
    })

    // Handle errors to prevent unhandled rejections
    this.queue.on('error', (err) => {
    })

    // Set up the job processor
    this.queue.process(async (job) => {
      return { result: 'success', sum: job.data.x + job.data.y }
    })
  }

  async teardown () {
    try {
      await this.queue.close()
    } catch (error) {
    }
  }

  // --- Operations ---
  async jobSave () {
    const job = this.queue.createJob({ x: 2, y: 3 })
    await job.save()
  }

  async jobSaveError () {
    // Create a job with an invalid queue to trigger error
    const invalidQueue = new this.Queue('invalid-queue', {
      redis: {
        host: '127.0.0.1',
        port: 9999 // Invalid port
      }
    })
    const job = invalidQueue.createJob({ x: 1, y: 2 })
    await job.save()
  }

  async queueRunJob () {
    // Create and save a job that will be processed
    const job = this.queue.createJob({ x: 10, y: 20 })
    await job.save()

    // Wait for the job to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  async queueRunJobError () {
    try {
      // Create a separate queue with an error-throwing processor
      const errorQueue = new this.Queue('error-queue', {
        redis: {
          host: '127.0.0.1',
          port: 6379
        },
        isWorker: true,
        stallInterval: 1000
      })

      // Suppress error events to prevent unhandled errors
      errorQueue.on('error', (err) => {
      })

      errorQueue.process(async (job) => {
        throw new Error('Intentional processing error')
      })

      const job = errorQueue.createJob({ x: 1, y: 1 })
      await job.save()

      // Wait for processing attempt
      await new Promise((resolve) => setTimeout(resolve, 2000))

      await errorQueue.close()
    } catch (error) {
      // Don't re-throw, just log it
    }
  }

  async queueSaveAll () {
    const jobs = [
      this.queue.createJob({ x: 3, y: 4 }),
      this.queue.createJob({ x: 5, y: 6 }),
      this.queue.createJob({ x: 7, y: 8 })
    ]
    await this.queue.saveAll(jobs)
  }

  async queueSaveAllError () {
    const invalidQueue = new this.Queue('invalid-queue-batch', {
      redis: {
        host: '127.0.0.1',
        port: 9999
      }
    })
    const jobs = [
      invalidQueue.createJob({ x: 1, y: 2 })
    ]
    await invalidQueue.saveAll(jobs)
  }

  async produceAndConsume () {
    // Create a job that will be processed, and wait for processing to complete
    const job = this.queue.createJob({ x: 100, y: 200 })
    await job.save()

    // Wait for the job to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

module.exports = BeeQueueTestSetup
