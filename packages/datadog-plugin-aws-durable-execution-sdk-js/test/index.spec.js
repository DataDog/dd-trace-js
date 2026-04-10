'use strict'

const sinon = require('sinon')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

/**
 * Searches all received spans for one matching `expected.name` and asserts
 * that it contains the expected properties via `assertObjectContains`.
 *
 * @param {Array<Array<object>>} traces - 2D array of traces/spans from the mock agent
 * @param {object} expected - Object with `name` and other span properties to match
 */
function assertSpanByName (traces, expected) {
  const allSpans = traces.flat()
  const span = allSpans.find(s => s.name === expected.name)
  if (!span) {
    const names = allSpans.map(s => s.name)
    throw new Error(`Expected span "${expected.name}" not found. Available: ${JSON.stringify(names)}`)
  }
  assertObjectContains(span, expected)
}

createIntegrationTestSuite('aws-durable-execution-sdk-js', '@aws/durable-execution-sdk-js', {
  category: 'orchestration',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('withDurableExecution() - workflow.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'server',
          },
        })
      })

      await testSetup.withDurableExecution()

      return traceAssertion
    })

    it('should generate span even when handler errors (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'server',
          },
        })
      })

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
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      await testSetup.durableContextImplStep()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
            'error.type': 'StepError',
            'error.message': 'Intentional step error',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplStepError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.runInChildContext() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      await testSetup.durableContextImplRunInChildContext()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
            'error.type': 'ChildContextError',
            'error.message': 'Intentional child context error',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplRunInChildContextError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.waitForCondition() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      await testSetup.durableContextImplWaitForCondition()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
            'error.type': 'Error',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplWaitForConditionError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.waitForCallback() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      await testSetup.durableContextImplWaitForCallback()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
            'error.type': 'CallbackError',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplWaitForCallbackError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.createCallback() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      await testSetup.durableContextImplCreateCallback()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
            'error.type': 'CallbackError',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplCreateCallbackError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.map() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      await testSetup.durableContextImplMap()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
            'error.type': 'ChildContextError',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplMapError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.parallel() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      await testSetup.durableContextImplParallel()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
            'error.type': 'ChildContextError',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplParallelError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.invoke() - lambda.invoke', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'lambda.invoke',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'client',
          },
        })
      })

      await testSetup.durableContextImplInvoke()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'lambda.invoke',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'client',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplInvokeError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('peer service computation', () => {
    let computePeerServiceSpy

    beforeEach(() => {
      const tracer = require('../../dd-trace')
      const plugin = tracer._pluginManager._pluginsByName['aws-durable-execution-sdk-js']
      computePeerServiceSpy = sinon.stub(plugin._tracerConfig, 'spanComputePeerService').value(true)
    })

    afterEach(() => {
      computePeerServiceSpy.restore()
    })

    it('should set peer.service from functionname on lambda.invoke spans', async () => {
      const expectedArn = 'arn:aws:lambda:us-east-1:123456789012:function:target'
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const invokeSpan = allSpans.find(s => s.name === 'lambda.invoke')
        if (!invokeSpan) {
          throw new Error(`Expected span "lambda.invoke" not found. Available: ${JSON.stringify(allSpans.map(s => s.name))}`)
        }
        assertObjectContains(invokeSpan, {
          name: 'lambda.invoke',
          resource: expectedArn,
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'client',
            functionname: expectedArn,
            'peer.service': expectedArn,
            '_dd.peer.service.source': 'functionname',
          },
        })
      })

      await testSetup.durableContextImplInvoke()

      return traceAssertion
    })
  })

  describe('DurableContextImpl.wait() - workflow.step.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      await testSetup.durableContextImplWait()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'workflow.step.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplWaitError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
