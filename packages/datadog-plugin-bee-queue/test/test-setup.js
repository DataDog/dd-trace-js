'use strict'
/* eslint-disable no-console, no-unused-vars */

class BeeQueueTestSetup {
  async setup (module) {
    this.BeeQueue = module
    const host = process.env.DOCKER_HOST || '127.0.0.1'
    this.queueName = 'test-queue'
    this.queue = new this.BeeQueue(this.queueName, {
      redis: { host, port: 6379 }
    })
    await this.queue.ready()
  }
  async teardown () {
    if (this.queue) {
      try { await this.queue.close() } catch (e) {}
    }
  }
  async produce ({ destination, message, expectError }) {
    if (expectError) {
      const host = process.env.DOCKER_HOST || '127.0.0.1'
      const tmp = new this.BeeQueue(`${this.queueName}-tmp`, { redis: { host, port: 6379 } })
      await tmp.ready()
      await tmp.close()
      try {
        await tmp.createJob({ foo: 'bar' }).save()
      } finally {
        try { await tmp.close() } catch (e) {}
      }
      return
    }
    const job = await this.queue.createJob(message || { data: 'test' }).save()
    return job
  }

  async consume ({ destination, expectError }) {
    if (expectError) {
      return new Promise((resolve, reject) => {
        this.queue.on('failed', (job, err) => reject(err))
        this.queue.process(async () => { throw new Error('forced-consumer-error') })
        this.queue.createJob({ data: 'trigger-error' }).save().catch(() => {})
      })
    }

    const done = new Promise((resolve) => {
      this.queue.process(async (job) => {
        resolve({ message: job.data })
      })
    })

    await this.queue.createJob({ data: 'consume' }).save()
    return done
  }

  async process ({ destination, trigger_message, expectError }) {
    if (expectError) {
      const errorPromise = new Promise((resolve) => {
        this.queue.on('failed', (job, err) => {
          if (err && err.message === 'forced-process-error') resolve()
        })
      })
      this.queue.process(async () => { throw new Error('forced-process-error') })
      await this.queue.createJob(trigger_message || { data: 'trigger' }).save().catch(() => {})
      return errorPromise
    }

    const done = new Promise((resolve) => {
      this.queue.process(async (job) => {
        resolve({ message: job.data })
      })
    })

    await this.queue.createJob(trigger_message || { data: 'trigger' }).save()

    return done
  }
}
module.exports = BeeQueueTestSetup
