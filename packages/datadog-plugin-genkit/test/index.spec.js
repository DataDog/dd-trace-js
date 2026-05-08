'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('genkit', 'genkit', {
  category: 'generative-ai',
}, (meta) => {
  const { agent, tracer, span } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('GenkitAI.generate() - genkit.generate', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'genkit.generate',
          meta: {
            'span.kind': 'client',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.genkitAIGenerate()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'genkit.generate',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
          },
          metrics: {},
          error: 1,
        }
      )

      // Execute operation error variant
      try {
        await testSetup.genkitAIGenerateError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('GenkitAI.generateStream() - genkit.generate', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'genkit.generateStream',
          meta: {
            'span.kind': 'client',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.genkitAIGenerateStream()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'genkit.generateStream',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
          },
          metrics: {},
          error: 1,
        }
      )

      // Execute operation error variant
      try {
        await testSetup.genkitAIGenerateStreamError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Chat.send() - genkit.chat', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'genkit.send',
          meta: {
            'span.kind': 'client',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.chatSend()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'genkit.send',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
          },
          metrics: {},
          error: 1,
        }
      )

      // Execute operation error variant
      try {
        await testSetup.chatSendError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('defineAction() - genkit.{flow|tool|model|embedder|retriever}', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'genkit.defineAction',
          meta: {
            'span.kind': 'internal',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.defineAction()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'genkit.defineAction',
          meta: {
            'span.kind': 'internal',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
          },
          metrics: {},
          error: 1,
        }
      )

      // Execute operation error variant
      try {
        await testSetup.defineActionError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
