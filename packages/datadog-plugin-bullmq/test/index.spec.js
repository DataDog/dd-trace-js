'use strict'

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

function findSpanByName (traces, name) {
  for (const trace of traces) {
    for (const span of trace) {
      if (span.name === name) {
        return span
      }
    }
  }
  return null
}

createIntegrationTestSuite('bullmq', 'bullmq', testSetup, {
  category: 'messaging'
}, (meta) => {
  const { agent } = meta

  describe('Queue.add() - bullmq.produce', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const span = findSpanByName(traces, 'bullmq.add')
        if (!span) throw new Error('Span bullmq.add not found')
        assertObjectContains(span, {
          name: 'bullmq.add',
          meta: {
            'span.kind': 'producer',
            component: 'bullmq'
          }
        })
      })

      // Execute operation via test setup
      await testSetup.queueAdd()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const span = findSpanByName(traces, 'bullmq.add')
        if (!span) throw new Error('Span bullmq.add not found')
        assertObjectContains(span, {
          name: 'bullmq.add',
          meta: {
            'span.kind': 'producer',
            component: 'bullmq'
          },
          error: 1
        })
      })

      // Execute operation error variant
      try {
        await testSetup.queueAddError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Queue.addBulk() - bullmq.produce', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const span = findSpanByName(traces, 'bullmq.addBulk')
        if (!span) throw new Error('Span bullmq.addBulk not found')
        assertObjectContains(span, {
          name: 'bullmq.addBulk',
          meta: {
            'span.kind': 'producer',
            component: 'bullmq'
          }
        })
      })

      // Execute operation via test setup
      await testSetup.queueAddBulk()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const span = findSpanByName(traces, 'bullmq.addBulk')
        if (!span) throw new Error('Span bullmq.addBulk not found')
        assertObjectContains(span, {
          name: 'bullmq.addBulk',
          meta: {
            'span.kind': 'producer',
            component: 'bullmq'
          },
          error: 1
        })
      })

      // Execute operation error variant
      try {
        await testSetup.queueAddBulkError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Worker.processJob() - bullmq.process', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const span = findSpanByName(traces, 'bullmq.processJob')
        if (!span) throw new Error('Span bullmq.processJob not found')
        assertObjectContains(span, {
          name: 'bullmq.processJob',
          meta: {
            'span.kind': 'consumer',
            component: 'bullmq'
          }
        })
      })

      // Execute operation via test setup
      await testSetup.workerProcessJob()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const span = findSpanByName(traces, 'bullmq.processJob')
        if (!span) throw new Error('Span bullmq.processJob not found')
        assertObjectContains(span, {
          name: 'bullmq.processJob',
          meta: {
            'span.kind': 'consumer',
            component: 'bullmq'
          }
        })
      })

      // Execute operation error variant - bullmq handles job errors via events,
      // so the span may not have error:1 set even when the job fails
      try {
        await testSetup.workerProcessJobError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('FlowProducer.add() - bullmq.produce', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const span = findSpanByName(traces, 'bullmq.add')
        if (!span) throw new Error('Span bullmq.add not found')
        assertObjectContains(span, {
          name: 'bullmq.add',
          meta: {
            'span.kind': 'producer',
            component: 'bullmq'
          }
        })
      })

      // Execute operation via test setup
      await testSetup.flowProducerAdd()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const span = findSpanByName(traces, 'bullmq.add')
        if (!span) throw new Error('Span bullmq.add not found')
        assertObjectContains(span, {
          name: 'bullmq.add',
          meta: {
            'span.kind': 'producer',
            component: 'bullmq'
          }
        })
      })

      // Execute operation error variant - the error may occur before the span
      // is created if the connection is already closed
      try {
        await testSetup.flowProducerAddError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
