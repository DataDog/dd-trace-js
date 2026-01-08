'use strict'

const assert = require('node:assert/strict')

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { withPeerService } = require('../../dd-trace/test/setup/mocha')
const { ANY_STRING } = require('../../../integration-tests/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('bee-queue', 'bee-queue', {
  category: 'messaging'
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('Job.save() - produce', () => {
    withPeerService(
      () => meta.tracer,
      'bee-queue',
      () => testSetup.jobSave(),
      'test-queue',
      'messaging.destination.name'
    )

    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'bee-queue.save',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'bee-queue',
            'messaging.destination.name': 'test-queue',
            'messaging.operation': 'produce',
            component: 'bee-queue'
          }
        }
      )

      // Execute operation via test setup
      await testSetup.jobSave()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'bee-queue.save',
          meta: {
            'span.kind': 'producer',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
            'messaging.system': 'bee-queue',
            'messaging.destination.name': 'invalid-queue',
            'messaging.operation': 'produce',
            component: 'bee-queue'
          },
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.jobSaveError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Queue._runJob() - process', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'bee-queue._runJob',
          meta: {
            'span.kind': 'consumer',
            'messaging.system': 'bee-queue',
            'messaging.destination.name': 'test-queue',
            'messaging.operation': 'process',
            component: 'bee-queue'
          }
        }
      )

      // Execute operation via test setup
      await testSetup.queueRunJob()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'bee-queue._runJob',
          meta: {
            'span.kind': 'consumer',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
            'messaging.system': 'bee-queue',
            'messaging.destination.name': ANY_STRING,
            'messaging.operation': 'process',
            component: 'bee-queue'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.queueRunJobError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Queue.saveAll() - produce', () => {
    withPeerService(
      () => meta.tracer,
      'bee-queue',
      () => testSetup.queueSaveAll(),
      'test-queue',
      'messaging.destination.name'
    )

    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'bee-queue.saveAll',
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

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'bee-queue.saveAll',
          meta: {
            'span.kind': 'producer',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
            'messaging.system': 'bee-queue',
            'messaging.destination.name': ANY_STRING,
            'messaging.operation': 'produce',
            component: 'bee-queue',
            'messaging.batch.message_count': ANY_STRING
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.queueSaveAllError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Context propagation', () => {
    it('should propagate context from producer to consumer', async () => {
      const traceAssertion = agent.assertSomeTraces(traces => {
        // Find the consumer span
        const consumerSpan = traces
          .flat()
          .find(span => span.name === 'bee-queue._runJob')

        assert.ok(consumerSpan, 'Consumer span should exist')
        // Check that the consumer span has a parent_id (indicating context was propagated)
        assert.ok(
          parseInt(consumerSpan.parent_id.toString()) > 0,
          'Consumer span should have a parent_id from context propagation'
        )
      })

      // Execute operation via test setup
      await testSetup.produceAndConsume()

      return traceAssertion
    })
  })
})
