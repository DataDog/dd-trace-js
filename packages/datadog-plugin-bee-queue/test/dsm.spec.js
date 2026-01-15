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
  const edgeTags = [isProducer ? 'direction:out' : 'direction:in', `topic:${queueName}`, 'type:bee-queue']
  edgeTags.sort()
  return computePathwayHash('test', 'tester', edgeTags, parentHash)
}

createIntegrationTestSuite('bee-queue', 'bee-queue', {
  category: 'messaging'
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
      tracerInstance.use('bee-queue', { dsmEnabled: true })
    })

    describe('checkpoints', () => {
      let setDataStreamsContextSpy

      beforeEach(() => {
        setDataStreamsContextSpy = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
      })

      afterEach(() => {
        setDataStreamsContextSpy.restore()
      })

      it('should set a checkpoint on produce (Job.save)', async () => {
        await testSetup.jobSave()
        assert.strictEqual(setDataStreamsContextSpy.called, true)
        assert.deepStrictEqual(setDataStreamsContextSpy.args[0][0].hash, expectedProducerHash)
      })

      it('should set a checkpoint on produce (Queue.saveAll)', async () => {
        await testSetup.queueSaveAll()
        assert.strictEqual(setDataStreamsContextSpy.called, true)
        // saveAll should set checkpoint for each message in the batch
        assert.deepStrictEqual(setDataStreamsContextSpy.args[0][0].hash, expectedProducerHash)
      })

      it('should set a checkpoint on consume (Queue._runJob)', async function () {
        this.timeout(10000)
        await testSetup.queueRunJob()
        // After produce and consume, we should see consumer checkpoint
        const consumerCall = setDataStreamsContextSpy.getCalls().find(call => {
          return call.args[0]?.hash?.equals?.(expectedConsumerHash)
        })
        assert.ok(consumerCall, 'Consumer checkpoint call not found')
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
        await testSetup.jobSave()
        assert.strictEqual(recordCheckpointSpy.called, true)
        assert.ok(Object.hasOwn(recordCheckpointSpy.args[0][0], 'payloadSize'))
      })
    })
  })
})
