'use strict'

const assert = require('node:assert/strict')
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

  describe('withDurableExecution() - aws.durable.execute', () => {
    it('should generate span with execution_arn, invocation_status, replayed (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
            'aws.durable.execution_arn': 'arn:aws:lambda:us-east-1:123456789012:durable-execution/test-exec',
            'aws.durable.invocation_status': 'succeeded',
            'aws.durable.replayed': 'false',
          },
        })
      })

      const result = await testSetup.withDurableExecution()
      assert.ok(result !== undefined, 'withDurableExecution should return a result')

      return traceAssertion
    })

    it('should mark invocation_status=failed when handler throws', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.execute',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'aws.durable.invocation_status': 'failed',
          },
        })
      })

      try {
        await testSetup.withDurableExecutionError()
      } catch {
        // Expected error
      }

      return traceAssertion
    })

    it('should mark replayed=true when event has prior operations', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.execute',
          meta: {
            'aws.durable.replayed': 'true',
          },
        })
      })

      await testSetup.withDurableExecutionReplay()

      return traceAssertion
    })
  })

  describe('DurableContextImpl.step() - aws.durable.step', () => {
    it('should generate span with replayed=false on initial run', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.step',
          resource: 'test-step',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
            'aws.durable.replayed': 'false',
          },
        })
      })

      const result = await testSetup.durableContextImplStep()
      assert.ok(result !== undefined, 'step should return a result')

      return traceAssertion
    })

    it('should mark span as errored on terminal failure', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.step',
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
      } catch {
        // Expected error
      }

      return traceAssertion
    })

    it('should attach the user error to the step span when retry is triggered', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.step',
          resource: 'retry-step',
          meta: {
            'error.type': 'Error',
            'error.message': 'transient failure',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplStepWithRetry()
      } catch {
        // The workflow may suspend (return PENDING) — that's not an error to the caller.
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.runInChildContext() - aws.durable.child_context', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.child_context',
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
          name: 'aws.durable.child_context',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'error.type': 'ChildContextError',
            'error.message': 'Intentional child context error',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplRunInChildContextError()
      } catch {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.waitForCondition() - aws.durable.wait_for_condition', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.wait_for_condition',
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
          name: 'aws.durable.wait_for_condition',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'error.type': 'Error',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplWaitForConditionError()
      } catch {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.waitForCallback() - aws.durable.wait_for_callback', () => {
    it('should generate span without aws.durable.replayed tag', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const span = allSpans.find(s => s.name === 'aws.durable.wait_for_callback')
        if (!span) throw new Error('aws.durable.wait_for_callback span not found')
        assertObjectContains(span, {
          name: 'aws.durable.wait_for_callback',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
        // Per spec §4.2: wait_for_callback intentionally does not get the replayed tag.
        assert.equal(span.meta?.['aws.durable.replayed'], undefined)
      })

      await testSetup.durableContextImplWaitForCallback()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.wait_for_callback',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'error.type': 'ChildContextError',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplWaitForCallbackError()
      } catch {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.createCallback() - aws.durable.create_callback', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.create_callback',
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
          name: 'aws.durable.create_callback',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'error.type': 'CallbackError',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplCreateCallbackError()
      } catch {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.map() - aws.durable.map', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.map',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      await testSetup.durableContextImplMap()

      return traceAssertion
    })

    it('should not emit internal child_context spans and step children should keep default resource', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const mapSpan = allSpans.find(s => s.name === 'aws.durable.map')
        if (!mapSpan) throw new Error('aws.durable.map span not found')
        const traceId = mapSpan.trace_id?.toString()

        const childContextSpans = allSpans.filter(s =>
          s.name === 'aws.durable.child_context' &&
          s.trace_id?.toString() === traceId
        )
        assert.equal(
          childContextSpans.length, 0,
          `expected no child_context spans inside map; saw ${childContextSpans.length}`
        )

        const stepChildren = allSpans.filter(s =>
          s.name === 'aws.durable.step' &&
          s.parent_id?.toString() === mapSpan.span_id?.toString()
        )
        assert.ok(
          stepChildren.length >= 2,
          `expected step children directly under map; saw ${stepChildren.length}`
        )
        for (const step of stepChildren) {
          assert.equal(
            step.resource, 'aws.durable.step',
            `expected default resource on map child step, got "${step.resource}"`
          )
        }
      })

      await testSetup.durableContextImplMapWithSteps()

      return traceAssertion
    })
  })

  describe('DurableContextImpl.parallel() - aws.durable.parallel', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.parallel',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'internal',
          },
        })
      })

      await testSetup.durableContextImplParallel()

      return traceAssertion
    })

    it('should not emit internal child_context spans and step children should keep default resource', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const parallelSpan = allSpans.find(s => s.name === 'aws.durable.parallel')
        if (!parallelSpan) throw new Error('aws.durable.parallel span not found')
        const traceId = parallelSpan.trace_id?.toString()

        const childContextSpans = allSpans.filter(s =>
          s.name === 'aws.durable.child_context' &&
          s.trace_id?.toString() === traceId
        )
        assert.equal(
          childContextSpans.length, 0,
          `expected no child_context spans inside parallel; saw ${childContextSpans.length}`
        )

        const stepChildren = allSpans.filter(s =>
          s.name === 'aws.durable.step' &&
          s.parent_id?.toString() === parallelSpan.span_id?.toString()
        )
        assert.ok(
          stepChildren.length >= 2,
          `expected step children directly under parallel; saw ${stepChildren.length}`
        )
        for (const step of stepChildren) {
          assert.equal(
            step.resource, 'aws.durable.step',
            `expected default resource on parallel child step, got "${step.resource}"`
          )
        }
      })

      await testSetup.durableContextImplParallelWithSteps()

      return traceAssertion
    })
  })

  describe('DurableContextImpl.invoke() - aws.durable.invoke', () => {
    it('should generate span with function_name tag', async () => {
      const expectedArn = 'arn:aws:lambda:us-east-1:123456789012:function:target'
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.invoke',
          resource: 'test-func',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'span.kind': 'client',
            'aws.durable.invoke.function_name': expectedArn,
            'aws.durable.replayed': 'false',
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
          name: 'aws.durable.invoke',
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
      } catch {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('DurableContextImpl.wait() - aws.durable.wait', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        assertSpanByName(traces, {
          name: 'aws.durable.wait',
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
          name: 'aws.durable.wait',
          meta: {
            component: 'aws-durable-execution-sdk-js',
            'error.type': 'TypeError',
          },
          error: 1,
        })
      })

      try {
        await testSetup.durableContextImplWaitError()
      } catch {
        // Expected error
      }

      return traceAssertion
    })
  })
})
