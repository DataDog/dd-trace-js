'use strict'

class BullmqTestSetup {
  async setup (module) {
    // Store module reference for later use
    this.module = module

    // Redis connection config
    const connection = {
      host: '127.0.0.1',
      port: 6379
    }

    // Create Queue
    this.queue = new module.Queue('test-queue', { connection })

    // Create FlowProducer
    this.flowProducer = new module.FlowProducer({ connection })

    // Create Worker
    this.worker = new module.Worker('test-queue', async (job) => {
      return { success: true, processedAt: Date.now() }
    }, { connection })
  }

  async teardown () {
    try {
      if (this.worker) {
        await this.worker.close()
      }
    } catch (error) {
    }

    try {
      if (this.flowProducer) {
        await this.flowProducer.close()
      }
    } catch (error) {
    }

    try {
      if (this.queue) {
        await this.queue.close()
      }
    } catch (error) {
    }
  }

  // --- Operations ---
  async queueAdd () {
    await this.queue.add('paint-car', {
      color: 'blue',
      model: 'sedan'
    })
  }

  async queueAddError () {
    // Create a separate queue and close it to force an error when trying to add
    const errorQueue = new this.module.Queue('error-queue-add', {
      connection: { host: '127.0.0.1', port: 6379 }
    })
    await errorQueue.close()
    await errorQueue.add('invalid-job', { test: true })
  }

  async queueAddBulk () {
    await this.queue.addBulk([
      { name: 'paint-car', data: { color: 'red', model: 'coupe' } },
      { name: 'paint-car', data: { color: 'green', model: 'truck' } },
      { name: 'wash-car', data: { type: 'full-service' } }
    ])
  }

  async queueAddBulkError () {
    // Create a separate queue and close it to force an error when trying to addBulk
    const errorQueue = new this.module.Queue('error-queue-bulk', {
      connection: { host: '127.0.0.1', port: 6379 }
    })
    await errorQueue.close()
    await errorQueue.addBulk([{ name: 'test', data: { test: true } }])
  }

  async workerProcessJob () {
    // Add a job to trigger processing
    await this.queue.add('process-test', {
      message: 'This will be processed by worker'
    })

    // Wait for worker to process the job
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  async flowProducerAdd () {
    await this.flowProducer.add({
      name: 'root-job',
      queueName: 'test-queue',
      data: { stage: 'root' },
      children: [
        {
          name: 'child-job-1',
          queueName: 'test-queue',
          data: { stage: 'child-1' }
        },
        {
          name: 'child-job-2',
          queueName: 'test-queue',
          data: { stage: 'child-2' },
          children: [
            {
              name: 'grandchild-job',
              queueName: 'test-queue',
              data: { stage: 'grandchild' }
            }
          ]
        }
      ]
    })
  }

  async flowProducerAddError () {
    // Create a separate flow producer and close it to force an error when trying to add
    const errorFlowProducer = new this.module.FlowProducer({
      connection: { host: '127.0.0.1', port: 6379 }
    })
    await errorFlowProducer.close()
    await errorFlowProducer.add({
      name: 'invalid-flow',
      queueName: 'test-queue',
      data: {}
    })
  }

  async workerProcessJobError () {
    // Create a separate worker that throws an error during processing
    const errorWorker = new this.module.Worker('error-queue', async (job) => {
      throw new Error('Intentional processing error')
    }, { connection: { host: '127.0.0.1', port: 6379 } })

    // Create a separate queue for the error test
    const errorQueue = new this.module.Queue('error-queue', {
      connection: { host: '127.0.0.1', port: 6379 }
    })

    // Add a job to the error queue
    await errorQueue.add('error-job', { test: true })

    // Wait for the worker to process and fail
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Clean up
    await errorWorker.close()
    await errorQueue.close()
  }
}

module.exports = BullmqTestSetup
