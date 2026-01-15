'use strict'

/* eslint-disable no-console */

class BeeQueueTestSetup {
  async setup (BeeQueue) {
    this.queue = null
    this.processedJobs = []
    this.processedJobsResolvers = []
    // Create queue with Redis connection
    this.queue = new BeeQueue('test-queue', {
      redis: {
        host: '127.0.0.1',
        port: 6379
      },
      isWorker: true,
      getEvents: true,
      sendEvents: true,
      storeJobs: true,
      removeOnSuccess: true,
      removeOnFailure: true,
      activateDelayedJobs: true
    })

    // Wait for ready
    await this.queue.ready()

    // Set up processor to handle jobs
    // This triggers module._runJob internally when processing
    this.queue.process(async (job) => {
      this.processedJobs.push(job.id)

      // Resolve any waiting promises
      if (this.processedJobsResolvers.length > 0) {
        const resolver = this.processedJobsResolvers.shift()
        resolver()
      }

      // Simulate some work
      if (job.data.shouldFail) {
        throw new Error('Intentional job failure')
      }

      return { success: true, processed: job.data }
    })
  }

  waitForProcessing (count) {
    return new Promise((resolve) => {
      let processed = 0
      const checkDone = () => {
        processed++
        if (processed >= count) {
          resolve()
        }
      }

      for (let i = 0; i < count; i++) {
        this.processedJobsResolvers.push(checkDone)
      }
    })
  }

  async teardown () {
    if (this.queue) {
      await this.queue.close(5000)
    }
  }

  // --- Operations ---
  async jobSave () {
    const job = this.queue.createJob({
      message: 'Hello from jobSave',
      timestamp: Date.now()
    })

    // Configure the job before saving
    job.timeout(5000).retries(2)

    // Save triggers the produce operation
    const savedJob = await job.save()

    // Wait a bit for processing
    await this.waitForProcessing(1)

    return savedJob
  }

  async jobSaveError () {
    // Create a job that will fail during processing
    const job = this.queue.createJob({
      message: 'This job should fail',
      shouldFail: true
    })

    job.timeout(5000).retries(0) // No retries so it fails immediately

    const savedJob = await job.save()

    // Wait for the job to be processed and fail
    await this.waitForProcessing(1)

    return savedJob
  }

  async queueRunJob () {
    // Create and save a job, then wait for it to be processed
    // This triggers the _runJob consumer operation
    const job = this.queue.createJob({
      message: 'Hello from queueRunJob',
      timestamp: Date.now()
    })

    job.timeout(5000).retries(2)

    const savedJob = await job.save()

    // Wait for the job to be processed
    await this.waitForProcessing(1)

    return savedJob
  }

  async queueRunJobError () {
    // Create and save a job that will fail during processing
    // This triggers the _runJob consumer operation with an error
    const job = this.queue.createJob({
      message: 'This job should fail during processing',
      shouldFail: true
    })

    job.timeout(5000).retries(0) // No retries so it fails immediately

    const savedJob = await job.save()

    // Wait for the job to be processed and fail
    await this.waitForProcessing(1)

    return savedJob
  }

  async queueSaveAll () {
    // Create multiple jobs for bulk save
    const jobs = [
      this.queue.createJob({ message: 'Bulk job 1', index: 1 }),
      this.queue.createJob({ message: 'Bulk job 2', index: 2 }),
      this.queue.createJob({ message: 'Bulk job 3', index: 3 })
    ]

    // Configure each job
    jobs.forEach(job => job.timeout(5000).retries(1))

    // saveAll saves all jobs in a pipelined request
    const errors = await this.queue.saveAll(jobs)

    if (errors.size > 0) {
      jobs.forEach(job => console.log(`  - Job id: ${job.id}`))
    } else {
      jobs.forEach(job => console.log(`  - Job id: ${job.id}`))
    }

    // Wait for processing
    await this.waitForProcessing(3)

    return jobs
  }

  async queueSaveAllError () {
    // Create jobs including one that will fail processing
    const jobs = [
      this.queue.createJob({ message: 'Bulk error job 1', index: 1, shouldFail: true }),
      this.queue.createJob({ message: 'Bulk error job 2', index: 2, shouldFail: true })
    ]

    jobs.forEach(job => job.timeout(5000).retries(0))

    await this.queue.saveAll(jobs)

    // Wait for processing (these will fail)
    await this.waitForProcessing(2)

    return jobs
  }

  async queueSaveAllSingle () {
    // Create a single job for bulk save to test context propagation
    const jobs = [
      this.queue.createJob({ message: 'Single bulk job', index: 1 })
    ]

    // Configure the job
    jobs.forEach(job => job.timeout(5000).retries(1))

    // saveAll saves all jobs in a pipelined request
    const errors = await this.queue.saveAll(jobs)

    if (errors.size > 0) {
      console.log('Some jobs failed to save:', errors)
    }

    // Wait for processing
    await this.waitForProcessing(1)

    return jobs
  }
}

module.exports = BeeQueueTestSetup
