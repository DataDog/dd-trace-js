'use strict'

const assert = require('node:assert/strict')
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

  describe('withDurableExecution() - aws.durable_execution.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.execute',
          service: 'aws.durable_execution',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'server',
          },
        })
      })

      const result = await testSetup.withDurableExecution()
      assert.ok(result !== undefined, 'withDurableExecution should return a result')

      return traceAssertion
    })

    it('should generate span even when handler errors (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'server',
          },
          error: 0,
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

  describe('DurableContextImpl.step() - aws.durable_execution.step', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.step',
          service: 'aws.durable_execution',
          resource: 'test-step',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      const result = await testSetup.durableContextImplStep()
      assert.ok(result !== undefined, 'step should return a result')

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.step',
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

  describe('DurableContextImpl.runInChildContext() - aws.durable_execution.child_context', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.child_context',
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
          name: 'aws.durable_execution.child_context',
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

  describe('DurableContextImpl.waitForCondition() - aws.durable_execution.wait_for_condition', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.wait_for_condition',
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
          name: 'aws.durable_execution.wait_for_condition',
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

  describe('DurableContextImpl.waitForCallback() - aws.durable_execution.wait_for_callback', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.wait_for_callback',
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
          name: 'aws.durable_execution.wait_for_callback',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
            'error.type': 'ChildContextError',
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

  describe('DurableContextImpl.createCallback() - aws.durable_execution.create_callback', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.create_callback',
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
          name: 'aws.durable_execution.create_callback',
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

  describe('DurableContextImpl.map() - aws.durable_execution.map', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.map',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      await testSetup.durableContextImplMap()

      return traceAssertion
    })

    it('should generate span even when callback errors (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.map',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
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

  describe('DurableContextImpl.parallel() - aws.durable_execution.parallel', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.parallel',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      await testSetup.durableContextImplParallel()

      return traceAssertion
    })

    it('should generate span even when branch errors (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.parallel',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
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

  describe('DurableContextImpl.invoke() - aws.durable_execution.invoke', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.invoke',
          service: 'aws.durable_execution',
          resource: 'test-func',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'client',
          },
        })
      })

      const result = await testSetup.durableContextImplInvoke()
      assert.ok(result !== undefined, 'invoke should return a result')

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.invoke',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'client',
            'error.type': 'InvokeError',
            'error.message': 'Intentional invoke error',
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

    it('should set peer.service from functionname on aws.durable_execution.invoke spans', async () => {
      const expectedArn = 'arn:aws:lambda:us-east-1:123456789012:function:target'
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const invokeSpan = allSpans.find(s => s.name === 'aws.durable_execution.invoke')
        if (!invokeSpan) {
          const available = JSON.stringify(allSpans.map(s => s.name))
          throw new Error(`Expected span "aws.durable_execution.invoke" not found. Available: ${available}`)
        }
        assertObjectContains(invokeSpan, {
          name: 'aws.durable_execution.invoke',
          resource: 'test-func',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'client',
            operationname: 'test-func',
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

  describe('DurableContextImpl.wait() - aws.durable_execution.wait', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable_execution.wait',
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
          name: 'aws.durable_execution.wait',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
            'error.type': 'TypeError',
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
