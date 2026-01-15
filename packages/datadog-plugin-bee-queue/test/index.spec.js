'use strict'

const assert = require('node:assert')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { withPeerService } = require('../../dd-trace/test/setup/mocha')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('bee-queue', 'bee-queue', {
  category: 'messaging'
}, (meta) => {
  const { agent } = meta
  let tracer

  before(async () => {
    tracer = require('../../dd-trace')
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('Job.save() - produce', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'bee-queue.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'bee-queue',
            'messaging.destination.name': 'test-queue',
            'messaging.operation': 'produce',
            component: 'bee-queue'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.jobSave()

      return traceAssertion
    })
  })

  describe('Queue._runJob() - process', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'bee-queue.process',
          meta: {
            'span.kind': 'consumer',
            'messaging.system': 'bee-queue',
            'messaging.destination.name': 'test-queue',
            'messaging.operation': 'process',
            component: 'bee-queue'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.queueRunJob()

      return traceAssertion
    })
  })

  describe('Queue.saveAll() - produce', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'bee-queue.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'bee-queue',
            'messaging.destination.name': 'test-queue',
            'messaging.operation': 'produce',
            component: 'bee-queue',
            'messaging.batch.message_count': '3'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.queueSaveAll()

      return traceAssertion
    })
  })

  describe('Peer Service', () => {
    withPeerService(
      () => tracer,
      'bee-queue',
      () => testSetup.jobSave(),
      'test-queue',
      'messaging.destination.name'
    )
  })

  describe('Context Propagation', () => {
    it('should link consumer span to producer span via distributed trace (Job.save)', async function () {
      this.timeout(15000)
      let producerSpan
      let consumerSpan

      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()

        for (const span of allSpans) {
          if (span.name === 'bee-queue.send') producerSpan = span
          if (span.name === 'bee-queue.process') consumerSpan = span
        }

        if (!producerSpan) {
          throw new Error('Producer span bee-queue.send not found')
        }
        if (!consumerSpan) {
          throw new Error('Consumer span bee-queue.process not found')
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

      await testSetup.queueRunJob()

      return traceAssertion
    })

    it('should link consumer span to producer span via distributed trace (Queue.saveAll)', async function () {
      this.timeout(15000)
      let producerSpan
      let consumerSpan

      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()

        for (const span of allSpans) {
          if (span.name === 'bee-queue.send') producerSpan = span
          if (span.name === 'bee-queue.process') consumerSpan = span
        }

        if (!producerSpan) {
          throw new Error('Producer span bee-queue.send not found')
        }
        if (!consumerSpan) {
          throw new Error('Consumer span bee-queue.process not found')
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

      await testSetup.queueSaveAllSingle()

      return traceAssertion
    })
  })
})
