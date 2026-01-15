'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { withPeerService } = require('../../dd-trace/test/setup/mocha')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('anthropic-ai-claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', {
  category: 'llm'
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  withPeerService(
    () => meta.tracer,
    'anthropic-ai-claude-agent-sdk',
    () => testSetup.query(),
    'anthropic',
    'ai.request.model_provider'
  )

  describe('query() - request', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'anthropic-ai-claude-agent-sdk.query',
          meta: {
            'span.kind': 'client',
            'ai.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'ai.request.model_provider': 'anthropic',
            'anthropic.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.query()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'anthropic-ai-claude-agent-sdk.query',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'ai.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'ai.request.model_provider': 'anthropic',
            'anthropic.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.queryError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('unstable_v2_prompt() - request', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'anthropic-ai-claude-agent-sdk.unstable_v2_prompt',
          meta: {
            'span.kind': 'client',
            'ai.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'ai.request.model_provider': 'anthropic',
            'anthropic.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.unstablev2prompt()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'anthropic-ai-claude-agent-sdk.unstable_v2_prompt',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'ai.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'ai.request.model_provider': 'anthropic',
            'anthropic.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.unstablev2promptError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('SDKSession.send() - send', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'anthropic-ai-claude-agent-sdk.send',
          meta: {
            'span.kind': 'client',
            'ai.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'ai.request.model_provider': 'anthropic',
            'anthropic.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.sDKSessionSend()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'anthropic-ai-claude-agent-sdk.send',
          meta: {
            'span.kind': 'client',
            'error.type': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.message': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'error.stack': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'ai.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE',
            'ai.request.model_provider': 'anthropic',
            'anthropic.request.model': 'FIX_THIS_WITH_ACTUAL_VALUE_OR_USE_ANY_STRING_IF_UNPREDICTABLE'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.sDKSessionSendError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
