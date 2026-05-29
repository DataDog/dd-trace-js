'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('nitro', 'nitro', {
  category: 'http-server',
}, (meta) => {
  const { agent, tracer, span } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('tracingPlugin() - request', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'nitro.tracingPlugin',
          meta: {
            'span.kind': 'server',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.tracingPlugin()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'nitro.tracingPlugin',
          meta: {
            'span.kind': 'server',
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
        await testSetup.tracingPluginError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('tracingPlugin() - request', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'nitro.tracingPlugin',
          meta: {
            'span.kind': 'server',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.tracingPlugin()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'nitro.tracingPlugin',
          meta: {
            'span.kind': 'server',
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
        await testSetup.tracingPluginError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
