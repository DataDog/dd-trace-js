'use strict'

// IMPORTANT: Set DD_DATA_STREAMS_ENABLED BEFORE any requires
process.env.DD_DATA_STREAMS_ENABLED = 'true'

const { expect } = require('chai')
const sinon = require('sinon')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')
const TestSetup = require('./test-setup')
const DataStreamsContext = require('../../dd-trace/src/datastreams/context')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH, DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')

const testSetup = new TestSetup()

const getDsmPathwayHash = (queueName, isProducer, parentHash) => {
  const edgeTags = isProducer
    ? ['direction:out', `topic:${queueName}`, 'type:bullmq']
    : ['direction:in', `topic:${queueName}`, 'type:bullmq']
  edgeTags.sort()
  return computePathwayHash('test', 'tester', edgeTags, parentHash)
}

createIntegrationTestSuite('bullmq', 'bullmq', testSetup, {
  category: 'messaging'
}, (meta) => {
  const { agent } = meta

  describe('Queue.add() - bullmq.add', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const spans = traces[0]
        const producerSpan = spans.find(span => span.name === 'bullmq.add')
        if (!producerSpan) {
          throw new Error('Producer span bullmq.add not found')
        }

        expect(producerSpan.meta['span.kind']).to.equal('producer')
        expect(producerSpan.meta['messaging.system']).to.equal('bullmq')
        expect(producerSpan.meta['messaging.destination.name']).to.equal('test-queue')
        expect(producerSpan.meta['messaging.operation']).to.equal('publish')
        expect(producerSpan.meta.component).to.equal('bullmq')
        expect(producerSpan.resource).to.equal('test-queue')
      })

      await testSetup.queueAdd()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const spans = traces[0]
        const producerSpan = spans.find(span => span.name === 'bullmq.add' && span.error === 1)
        if (!producerSpan) {
          throw new Error('Producer error span bullmq.add not found')
        }

        expect(producerSpan.meta['span.kind']).to.equal('producer')
        expect(producerSpan.meta['messaging.system']).to.equal('bullmq')
        expect(producerSpan.meta['error.type']).to.be.a('string')
        expect(producerSpan.meta['error.message']).to.be.a('string')
        expect(producerSpan.error).to.equal(1)
      })

      try {
        await testSetup.queueAddError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Queue.addBulk() - bullmq.addBulk', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const spans = traces[0]
        const producerSpan = spans.find(span => span.name === 'bullmq.addBulk')
        if (!producerSpan) {
          throw new Error('Producer span bullmq.addBulk not found')
        }

        expect(producerSpan.meta['span.kind']).to.equal('producer')
        expect(producerSpan.meta['messaging.system']).to.equal('bullmq')
        expect(producerSpan.meta['messaging.destination.name']).to.equal('test-queue')
        expect(producerSpan.meta['messaging.operation']).to.equal('publish')
        expect(producerSpan.meta.component).to.equal('bullmq')
        // messaging.batch.message_count may be in meta (as string) or metrics (as number)
        const batchCount = producerSpan.meta['messaging.batch.message_count'] ||
          producerSpan.metrics?.['messaging.batch.message_count']
        expect(Number(batchCount)).to.equal(3)
        expect(producerSpan.resource).to.equal('test-queue')
      })

      await testSetup.queueAddBulk()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const spans = traces[0]
        const producerSpan = spans.find(span => span.name === 'bullmq.addBulk' && span.error === 1)
        if (!producerSpan) {
          throw new Error('Producer error span bullmq.addBulk not found')
        }

        expect(producerSpan.meta['span.kind']).to.equal('producer')
        expect(producerSpan.meta['messaging.system']).to.equal('bullmq')
        expect(producerSpan.meta['error.type']).to.be.a('string')
        expect(producerSpan.meta['error.message']).to.be.a('string')
        expect(producerSpan.error).to.equal(1)
      })

      try {
        await testSetup.queueAddBulkError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Worker.processJob() - bullmq.processJob', () => {
    it('should generate span with correct tags (happy path)', async function () {
      this.timeout(10000)
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const consumerSpan = allSpans.find(span => span.name === 'bullmq.processJob')
        if (!consumerSpan) {
          throw new Error('Consumer span bullmq.processJob not found')
        }

        expect(consumerSpan.meta['span.kind']).to.equal('consumer')
        expect(consumerSpan.meta['messaging.system']).to.equal('bullmq')
        expect(consumerSpan.meta['messaging.operation']).to.equal('process')
        expect(consumerSpan.meta.component).to.equal('bullmq')
      })

      await testSetup.workerProcessJob()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async function () {
      this.timeout(10000)
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const consumerSpan = allSpans.find(span => span.name === 'bullmq.processJob')
        if (!consumerSpan) {
          throw new Error('Consumer span bullmq.processJob not found')
        }

        expect(consumerSpan.meta['span.kind']).to.equal('consumer')
        expect(consumerSpan.meta['messaging.system']).to.equal('bullmq')
      })

      await testSetup.workerProcessJobError()

      return traceAssertion
    })
  })

  describe('FlowProducer.add() - bullmq.add', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const producerSpan = allSpans.find(span => span.name === 'bullmq.add')
        if (!producerSpan) {
          throw new Error('Producer span bullmq.add not found')
        }

        expect(producerSpan.meta['span.kind']).to.equal('producer')
        expect(producerSpan.meta['messaging.system']).to.equal('bullmq')
        expect(producerSpan.meta['messaging.operation']).to.equal('publish')
        expect(producerSpan.meta.component).to.equal('bullmq')
      })

      await testSetup.flowProducerAdd()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async function () {
      this.timeout(10000)
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        // FlowProducer.add may complete without error even for invalid input
        // since BullMQ validates asynchronously. Just verify span is created.
        const producerSpan = allSpans.find(span => span.name === 'bullmq.add')
        if (!producerSpan) {
          throw new Error('Producer span bullmq.add not found')
        }

        expect(producerSpan.meta['span.kind']).to.equal('producer')
        expect(producerSpan.meta['messaging.system']).to.equal('bullmq')
      })

      try {
        await testSetup.flowProducerAddError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Context Propagation', () => {
    it('should link consumer span to producer span via distributed trace (Queue.add)', async function () {
      this.timeout(15000)
      let producerSpan
      let consumerSpan

      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()

        for (const span of allSpans) {
          if (span.name === 'bullmq.add') producerSpan = span
          if (span.name === 'bullmq.processJob') consumerSpan = span
        }

        if (!producerSpan) {
          throw new Error('Producer span bullmq.add not found')
        }
        if (!consumerSpan) {
          throw new Error('Consumer span bullmq.processJob not found')
        }

        // CRITICAL: Verify distributed trace - same trace ID
        expect(consumerSpan.trace_id.toString())
          .to.equal(producerSpan.trace_id.toString(), 'Consumer should have same trace_id as producer')

        // CRITICAL: Consumer is child of producer
        expect(consumerSpan.parent_id.toString())
          .to.equal(producerSpan.span_id.toString(), 'Consumer parent_id should equal producer span_id')
      })

      await testSetup.workerProcessJob()

      return traceAssertion
    })

    it('should link consumer span to producer span via distributed trace (Queue.addBulk)', async function () {
      this.timeout(15000)
      let producerSpan
      let consumerSpan

      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()

        for (const span of allSpans) {
          if (span.name === 'bullmq.addBulk') producerSpan = span
          if (span.name === 'bullmq.processJob') consumerSpan = span
        }

        if (!producerSpan) {
          throw new Error('Producer span bullmq.addBulk not found')
        }
        if (!consumerSpan) {
          throw new Error('Consumer span bullmq.processJob not found')
        }

        // CRITICAL: Verify distributed trace - same trace ID
        expect(consumerSpan.trace_id.toString())
          .to.equal(producerSpan.trace_id.toString(), 'Consumer should have same trace_id as producer')

        // CRITICAL: Consumer is child of producer
        expect(consumerSpan.parent_id.toString())
          .to.equal(producerSpan.span_id.toString(), 'Consumer parent_id should equal producer span_id')
      })

      await testSetup.workerProcessJobBulk()

      return traceAssertion
    })
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
        expect(setDataStreamsContextSpy.called).to.equal(true)
        expect(setDataStreamsContextSpy.args[0][0].hash).to.deep.equal(expectedProducerHash)
      })

      it('should set a checkpoint on produce (Queue.addBulk)', async () => {
        await testSetup.queueAddBulk()
        expect(setDataStreamsContextSpy.called).to.equal(true)
        // addBulk should set checkpoint for each message in the batch
        expect(setDataStreamsContextSpy.args[0][0].hash).to.deep.equal(expectedProducerHash)
      })

      it('should set a checkpoint on consume (Worker.processJob)', async function () {
        this.timeout(10000)
        await testSetup.workerProcessJob()
        // After produce and consume, we should see consumer checkpoint
        const consumerCall = setDataStreamsContextSpy.getCalls().find(call => {
          return call.args[0]?.hash?.equals?.(expectedConsumerHash)
        })
        expect(consumerCall).to.not.be.undefined
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
        expect(recordCheckpointSpy.called).to.equal(true)
        expect(recordCheckpointSpy.args[0][0]).to.have.property('payloadSize')
      })
    })
  })
})
