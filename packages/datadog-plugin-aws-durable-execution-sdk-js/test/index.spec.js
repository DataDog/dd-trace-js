'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('aws-durable-execution-sdk-js', '@aws/durable-execution-sdk-js', {
  category: 'orchestration',
}, (meta) => {
  const { agent, tracer, span } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('withDurableExecution() - workflow.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.withDurableExecution',
          meta: {
            'span.kind': 'server',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.withDurableExecution()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.withDurableExecution',
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
        await testSetup.withDurableExecutionError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.step() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.step',
          meta: {
            'span.kind': 'internal',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.durableContextImplStep()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.step',
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
        await testSetup.durableContextImplStepError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.invoke() - lambda.invoke', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.invoke',
          meta: {
            'span.kind': 'client',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.durableContextImplInvoke()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.invoke',
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
        await testSetup.durableContextImplInvokeError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.runInChildContext() - workflow.child_context.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.runInChildContext',
          meta: {
            'span.kind': 'internal',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.durableContextImplRunInChildContext()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.runInChildContext',
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
        await testSetup.durableContextImplRunInChildContextError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.wait() - workflow.wait', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.wait',
          meta: {
            'span.kind': 'internal',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.durableContextImplWait()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.wait',
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
        await testSetup.durableContextImplWaitError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.waitForCondition() - workflow.wait_for_condition', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.waitForCondition',
          meta: {
            'span.kind': 'internal',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.durableContextImplWaitForCondition()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.waitForCondition',
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
        await testSetup.durableContextImplWaitForConditionError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.waitForCallback() - workflow.wait_for_callback', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.waitForCallback',
          meta: {
            'span.kind': 'internal',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.durableContextImplWaitForCallback()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.waitForCallback',
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
        await testSetup.durableContextImplWaitForCallbackError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.createCallback() - workflow.create_callback', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.createCallback',
          meta: {
            'span.kind': 'internal',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.durableContextImplCreateCallback()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.createCallback',
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
        await testSetup.durableContextImplCreateCallbackError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.map() - workflow.map', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.map',
          meta: {
            'span.kind': 'internal',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.durableContextImplMap()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.map',
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
        await testSetup.durableContextImplMapError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.parallel() - workflow.parallel', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.parallel',
          meta: {
            'span.kind': 'internal',
          },
          metrics: {},
        }
      )

      // Execute operation via test setup
      await testSetup.durableContextImplParallel()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'aws-durable-execution-sdk-js.parallel',
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
        await testSetup.durableContextImplParallelError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
