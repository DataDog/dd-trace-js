'use strict'

/* eslint-disable no-console */

class BeeQueueTestSetup {
  async setup (module) {
    // Create a queue with Redis connection
    this.queue = new module('test-queue', {
      redis: {
        host: '127.0.0.1',
        port: 6379
      },
      isWorker: true,
      getEvents: true,
      removeOnSuccess: true,
      removeOnFailure: true
    })

    // Wait for queue to be ready
    await new Promise((resolve, reject) => {
      this.queue.on('ready', () => {
        resolve()
      })
      this.queue.on('error', (err) => {
        reject(err)
      })
    })
  }

  async teardown () {
    if (this.queue) {
      await this.queue.close(5000)
    }
  }

  // --- Operations ---
  async produce (options = {}) {
    try {
      // Create a job and save it (this calls Job.save internally)
      const job = this.queue.createJob({
        message: options.message || 'Hello from bee-queue',
        timestamp: Date.now()
      })

      // If expectError is true, simulate an error condition
      if (options.expectError) {
        // Force an error by corrupting the job
        job.queue = null
      }

      // Save the job - this is the instrumented method (Job.save)
      await job.save()
    } catch (error) {
      if (options.expectError) {
        throw error
      }
    }
  }

  async produce_bulk () {
    try {
      // Create multiple jobs
      const jobs = [
        this.queue.createJob({ message: 'Bulk job 1', index: 1 }),
        this.queue.createJob({ message: 'Bulk job 2', index: 2 }),
        this.queue.createJob({ message: 'Bulk job 3', index: 3 })
      ]

      // Save all jobs using saveAll - this is the instrumented method
      await this.queue.saveAll(jobs)

      jobs.forEach(job => console.log(`  - Job ID: ${job.id}`))
    } catch (error) {
    }
  }

  async consume (options = {}) {
    // For bee-queue, consume means setting up a processor
    // and producing a job to trigger it
    return new Promise((resolve, reject) => {
      let resolved = false

      this.queue.process(async (job) => {
        try {
          if (options.expectError) {
            const err = new Error('Expected error in consume')
            if (!resolved) {
              resolved = true
              reject(err)
            }
            throw err
          }

          // Simulate some work
          await new Promise(resolve => setTimeout(resolve, 100))
          if (!resolved) {
            resolved = true
            resolve({ consumed: true, jobId: job.id })
          }
          return { consumed: true, jobId: job.id }
        } catch (error) {
          if (!resolved) {
            resolved = true
            reject(error)
          }
          throw error
        }
      })

      // Add a job to trigger the processor
      setTimeout(async () => {
        try {
          const job = this.queue.createJob({
            message: options.message || 'Consume test message',
            expectError: options.expectError
          })
          await job.save()
        } catch (error) {
          if (!resolved) {
            resolved = true
            reject(error)
          }
        }
      }, 100)

      // Set a timeout for the consume operation
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          resolve({ timeout: true })
        }
      }, 2000)
    })
  }

  async process (options = {}) {
    try {
      // Register a processor - this is the instrumented method (Queue.process)
      this.queue.process(async (job) => {
        // Simulate some work
        await new Promise(resolve => setTimeout(resolve, 100))

        return { processed: true, jobId: job.id }
      })

      // Wait for the job to be processed
      await new Promise(resolve => setTimeout(resolve, 2000))
    } catch (error) {
    }
  }

  async runAll () {
    try {
      await this.setup()

      await this.produce()

      await this.produce_bulk()

      await this.process()
    } catch (error) {
      process.exit(1)
    } finally {
      await this.teardown()
    }
  }
}

module.exports = BeeQueueTestSetup
