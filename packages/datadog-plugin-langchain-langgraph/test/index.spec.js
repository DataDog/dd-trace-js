'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('langchain-langgraph', '@langchain/langgraph', {
  category: 'llm'
}, (meta) => {
  const { agent, tracer, span } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('Pregel.invoke() - invoke', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'langchain-langgraph.invoke',
          meta: {
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.pregelInvoke()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'langchain-langgraph.invoke',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.pregelInvokeError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Pregel._streamIterator() - stream', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'langchain-langgraph._streamIterator',
          meta: {
            'span.kind': 'client',
            'ai.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'ai.request.model_provider': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'openai.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'anthropic.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.pregelStreamIterator()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'langchain-langgraph._streamIterator',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'ai.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'ai.request.model_provider': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'openai.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'anthropic.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.pregelStreamIteratorError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('_runWithRetry() - execute_node', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'langchain-langgraph._runWithRetry',
          meta: {
            'span.kind': 'internal'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.runWithRetry()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'langchain-langgraph._runWithRetry',
          meta: {
            'span.kind': 'internal',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.runWithRetryError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
