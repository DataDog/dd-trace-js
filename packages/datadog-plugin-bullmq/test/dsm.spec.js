'use strict'

// IMPORTANT: Set DD_DATA_STREAMS_ENABLED BEFORE any requires
process.env.DD_DATA_STREAMS_ENABLED = 'true'

const assert = require('node:assert')
const sinon = require('sinon')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const DataStreamsContext = require('../../dd-trace/src/datastreams/context')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH, DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

const getDsmPathwayHash = (queueName, isProducer, parentHash) => {
  const edgeTags = [isProducer ? 'direction:out' : 'direction:in', `topic:${queueName}`, 'type:bullmq']
  edgeTags.sort()
  return computePathwayHash('test', 'tester', edgeTags, parentHash)
}

createIntegrationTestSuite('bullmq', 'bullmq', {
  category: 'messaging',
}, (meta) => {
  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('Data Streams Monitoring (DSM)', () => {
    const queueName = 'test-queue'
    let expectedProducerHash
    let expectedConsumerHash

    beforeEach(() => {
      expectedProducerHash = getDsmPathwayHash(queueName, true, ENTRY_PARENT_HASH)
      expectedConsumerHash = getDsmPathwayHash(queueName, false, expectedProducerHash)
      // Require tracer directly since the meta.tracer is null at test definition time
      const tracerInstance = require('../../dd-trace')
      tracerInstance.use('bullmq', { dsmEnabled: true })
    })

    describe('checkpoints', () => {
      let setDataStreamsContextSpy

      beforeEach(() => {
        setDataStreamsContextSpy = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
      })

      afterEach(() => {
        setDataStreamsContextSpy.restore()
      })

      it('should set a checkpoint on produce (Queue.add)', async () => {
        await testSetup.queueAdd()
        assert.strictEqual(setDataStreamsContextSpy.called, true)
        assert.deepStrictEqual(setDataStreamsContextSpy.args[0][0].hash, expectedProducerHash)
      })

      it('should set a checkpoint on produce (Queue.addBulk)', async () => {
        await testSetup.queueAddBulk()
        assert.strictEqual(setDataStreamsContextSpy.called, true)
        // addBulk should set checkpoint for each message in the batch
        assert.deepStrictEqual(setDataStreamsContextSpy.args[0][0].hash, expectedProducerHash)
      })

      it('should set a checkpoint on consume (Worker.processJob)', async function () {
        this.timeout(10000)
        await testSetup.workerProcessJob()
        // After produce and consume, we should see consumer checkpoint
        const consumerCall = setDataStreamsContextSpy.getCalls().find(call => {
          return call.args[0]?.hash?.equals?.(expectedConsumerHash)
        })
        assert.ok(consumerCall, 'Consumer checkpoint call not found')
      })
    })

    describe('concurrent context isolation', function () {
      this.timeout(30000)

      it('should maintain separate DSM context for interleaved consume-produce flows', async () => {
        const bullmq = meta.mod
        const connection = { host: '127.0.0.1', port: 6379 }
        const setCheckpointSpy = sinon.spy(DataStreamsProcessor.prototype, 'setCheckpoint')

        const queueA = new bullmq.Queue('dsm-iso-a', { connection })
        const queueB = new bullmq.Queue('dsm-iso-b', { connection })
        const queueAOut = new bullmq.Queue('dsm-iso-a-out', { connection })
        const queueBOut = new bullmq.Queue('dsm-iso-b-out', { connection })

        // Synchronization: both workers must enter before either produces
        let resolveAEntered, resolveBEntered
        const aEntered = new Promise(resolve => { resolveAEntered = resolve })
        const bEntered = new Promise(resolve => { resolveBEntered = resolve })

        const workerA = new bullmq.Worker('dsm-iso-a', async () => {
          resolveAEntered()
          await bEntered
          await queueAOut.add('from-a', { message: 'from-a' })
        }, { connection })

        const workerB = new bullmq.Worker('dsm-iso-b', async () => {
          resolveBEntered()
          await aEntered
          await queueBOut.add('from-b', { message: 'from-b' })
        }, { connection })

        const queueAEvents = new bullmq.QueueEvents('dsm-iso-a', { connection })
        const queueBEvents = new bullmq.QueueEvents('dsm-iso-b', { connection })

        await Promise.all([
          workerA.waitUntilReady(), workerB.waitUntilReady(),
          queueAEvents.waitUntilReady(), queueBEvents.waitUntilReady(),
        ])

        try {
          const jobA = await queueA.add('msg-a', { message: 'msg-a' })
          const jobB = await queueB.add('msg-b', { message: 'msg-b' })

          await Promise.all([
            jobA.waitUntilFinished(queueAEvents),
            jobB.waitUntilFinished(queueBEvents),
          ])

          // setCheckpoint(edgeTags, span, parentCtx, payloadSize) → returns new DSM context
          const calls = setCheckpointSpy.getCalls()
          const checkpoint = (dir, topic) => calls.find(c =>
            c.args[0].includes(`direction:${dir}`) && c.args[0].includes(`topic:${topic}`)
          )

          const consumeA = checkpoint('in', 'dsm-iso-a')
          const consumeB = checkpoint('in', 'dsm-iso-b')
          const produceA = checkpoint('out', 'dsm-iso-a-out')
          const produceB = checkpoint('out', 'dsm-iso-b-out')

          assert.ok(produceA?.args[2], 'Process A produce should have a parent DSM context')
          assert.ok(produceB?.args[2], 'Process B produce should have a parent DSM context')
          assert.deepStrictEqual(produceA.args[2].hash, consumeA.returnValue.hash)
          assert.deepStrictEqual(produceB.args[2].hash, consumeB.returnValue.hash)
        } finally {
          setCheckpointSpy.restore()
          await Promise.all([
            workerA.close(), workerB.close(),
            queueA.close(), queueB.close(),
            queueAOut.close(), queueBOut.close(),
            queueAEvents.close(), queueBEvents.close(),
          ])
        }
      })
    })

    describe('payload size', () => {
      let recordCheckpointSpy

      beforeEach(() => {
        if (DataStreamsProcessor.prototype.recordCheckpoint.isSinonProxy) {
          DataStreamsProcessor.prototype.recordCheckpoint.restore()
        }
        recordCheckpointSpy = sinon.spy(DataStreamsProcessor.prototype, 'recordCheckpoint')
      })

      afterEach(() => {
        recordCheckpointSpy.restore()
      })

      it('should set a message payload size when producing a message', async () => {
        await testSetup.queueAdd()
        assert.strictEqual(recordCheckpointSpy.called, true)
        assert.ok(Object.hasOwn(recordCheckpointSpy.args[0][0], 'payloadSize'))
      })
    })
  })
})
