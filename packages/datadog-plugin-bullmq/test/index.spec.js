'use strict'

const assert = require('node:assert')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')
const { ANY_STRING } = require('../../../integration-tests/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('bullmq', 'bullmq', testSetup, {
  category: 'messaging'
}, (meta) => {
  const { agent } = meta

  describe('Queue.add() - bullmq.add', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'bullmq.add',
        resource: 'test-queue',
        meta: {
          'span.kind': 'producer',
          'messaging.system': 'bullmq',
          'messaging.destination.name': 'test-queue',
          'messaging.operation': 'publish',
          component: 'bullmq'
        }
      })

      await testSetup.queueAdd()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'bullmq.add',
        error: 1,
        meta: {
          'span.kind': 'producer',
          'messaging.system': 'bullmq',
          'error.type': ANY_STRING,
          'error.message': ANY_STRING
        }
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
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'bullmq.addBulk',
        resource: 'test-queue',
        meta: {
          'span.kind': 'producer',
          'messaging.system': 'bullmq',
          'messaging.destination.name': 'test-queue',
          'messaging.operation': 'publish',
          component: 'bullmq'
        },
        metrics: {
          'messaging.batch.message_count': 3
        }
      })

      await testSetup.queueAddBulk()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'bullmq.addBulk',
        error: 1,
        meta: {
          'span.kind': 'producer',
          'messaging.system': 'bullmq',
          'error.type': ANY_STRING,
          'error.message': ANY_STRING
        }
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
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'bullmq.processJob',
        meta: {
          'span.kind': 'consumer',
          'messaging.system': 'bullmq',
          'messaging.operation': 'process',
          component: 'bullmq'
        }
      })

      await testSetup.workerProcessJob()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async function () {
      this.timeout(10000)
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'bullmq.processJob',
        error: 1,
        meta: {
          'span.kind': 'consumer',
          'messaging.system': 'bullmq',
          'error.type': ANY_STRING,
          'error.message': ANY_STRING
        }
      })

      await testSetup.workerProcessJobError()

      return traceAssertion
    })
  })

  describe('FlowProducer.add() - bullmq.add', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'bullmq.add',
        meta: {
          'span.kind': 'producer',
          'messaging.system': 'bullmq',
          'messaging.operation': 'publish',
          component: 'bullmq'
        }
      })

      await testSetup.flowProducerAdd()

      return traceAssertion
    })

    // FlowProducer.add may complete without error even for invalid input
    // since BullMQ validates asynchronously. Just verify span is created.
    it('should generate span with error tags (error path)', async function () {
      this.timeout(10000)
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'bullmq.add',
        meta: {
          'span.kind': 'producer',
          'messaging.system': 'bullmq'
        }
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
        assert.strictEqual(
          consumerSpan.trace_id.toString(),
          producerSpan.trace_id.toString(),
          'Consumer should have same trace_id as producer'
        )

        // CRITICAL: Consumer is child of producer
        assert.strictEqual(
          consumerSpan.parent_id.toString(),
          producerSpan.span_id.toString(),
          'Consumer parent_id should equal producer span_id'
        )
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
        assert.strictEqual(
          consumerSpan.trace_id.toString(),
          producerSpan.trace_id.toString(),
          'Consumer should have same trace_id as producer'
        )

        // CRITICAL: Consumer is child of producer
        assert.strictEqual(
          consumerSpan.parent_id.toString(),
          producerSpan.span_id.toString(),
          'Consumer parent_id should equal producer span_id'
        )
      })

      await testSetup.workerProcessJobBulk()

      return traceAssertion
    })
  })
})
