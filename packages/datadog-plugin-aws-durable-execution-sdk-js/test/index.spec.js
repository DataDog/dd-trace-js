'use strict'

const assert = require('node:assert/strict')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { TEST_FUNC_ARN, invokeHandler, setup, teardown } = require('./helpers')

const COMPONENT = 'aws-durable-execution-sdk-js'
const OPERATION_ID_RE = /^[a-f0-9]{16}$/
const defaultMeta = {
  component: COMPONENT,
  'span.kind': 'internal',
  'aws.durable.replayed': 'false',
}

function assertSpanByName (traces, expected) {
  const allSpans = traces.flat()
  const span = allSpans.find(s => s.name === expected.name)
  assert.ok(span, `expected span "${expected.name}", got: ${allSpans.map(s => s.name).join(', ')}`)
  assertObjectContains(span, expected)
  return span
}

// Asserts step children of `parentName` keep the default resource (cardinality protection)
// while still carrying the user-supplied operation_name.
function assertStepChildren (traces, parentName, expectedNames) {
  const allSpans = traces.flat()
  const parent = allSpans.find(s => s.name === parentName)
  assert.ok(parent, `${parentName} span not found`)
  const stepChildren = allSpans.filter(s =>
    s.name === 'aws.durable.step' && s.parent_id?.toString() === parent.span_id?.toString()
  )
  for (const step of stepChildren) {
    assert.equal(step.resource, 'aws.durable.step')
  }
  assert.deepStrictEqual(
    stepChildren.map(s => s.meta?.['aws.durable.operation_name']).sort(),
    [...expectedNames].sort()
  )
}

createIntegrationTestSuite('aws-durable-execution-sdk-js', '@aws/durable-execution-sdk-js', {
  category: 'orchestration',
}, (meta) => {
  const { agent } = meta

  beforeEach(async () => setup(meta.mod, meta.versionMod))
  afterEach(async () => teardown())

  describe('withDurableExecution() - aws.durable.execute', () => {
    it('happy: emits invocation_status=succeeded, replayed=false', async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: {
          ...defaultMeta,
          'aws.durable.invocation_status': 'succeeded',
        },
      }))

      const result = await invokeHandler(async () => {})
      assert.ok(result !== undefined, 'withDurableExecution should return a result')

      return trace
    })

    it('error: invocation_status=failed when handler throws', async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: { component: COMPONENT, 'aws.durable.invocation_status': 'failed' },
      }))

      // The SDK catches handler errors and returns FAILED without rethrowing.
      await invokeHandler(async () => { throw new Error('Intentional durable execution error') })

      return trace
    })

    // ctx.wait suspends invocation, reinvoked after waiting with replayed=true
    it('replay: replayed=true on resume after suspend', async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: { 'aws.durable.replayed': 'true' },
      }), { timeoutMs: 5000 })

      let invocations = 0
      await invokeHandler(async (event, ctx) => {
        invocations++
        await ctx.wait('replay-trigger', { seconds: 1 })
      })
      assert.equal(invocations, 2, 'expected the handler to be invoked twice (initial + replay)')

      return trace
    })
  })

  for (const { span, operationName, run, opts } of [
    {
      span: 'aws.durable.step',
      operationName: 'test-step',
      run: ctx => ctx.step('test-step', async () => {}),
    },
    {
      span: 'aws.durable.child_context',
      operationName: 'test-child',
      run: ctx => ctx.runInChildContext('test-child', async () => {}),
    },
    {
      span: 'aws.durable.wait',
      operationName: 'test-wait',
      run: ctx => ctx.wait('test-wait', { seconds: 1 }),
    },
    {
      span: 'aws.durable.wait_for_condition',
      operationName: 'test-condition',
      run: ctx => ctx.waitForCondition('test-condition', async () => {}, {
        waitStrategy: () => ({ shouldContinue: false }),
      }),
    },
    {
      span: 'aws.durable.wait_for_callback',
      operationName: 'test-callback',
      run: ctx => ctx.waitForCallback('test-callback', async () => {}),
      opts: { resolveCallback: 'test-callback' },
    },
    {
      span: 'aws.durable.create_callback',
      operationName: 'test-create-cb',
      run: ctx => ctx.createCallback('test-create-cb'),
    },
    {
      span: 'aws.durable.map',
      operationName: 'test-map',
      run: ctx => ctx.map('test-map', [1, 2, 3], async () => {}),
    },
    {
      span: 'aws.durable.parallel',
      operationName: 'test-parallel',
      run: ctx => ctx.parallel('test-parallel', [async () => {}, async () => {}]),
    },
  ]) {
    it(`${span} (happy path): emits span with expected tags`, async () => {
      const trace = agent.assertSomeTraces(traces => {
        const matched = assertSpanByName(traces, {
          name: span,
          resource: operationName,
          meta: { ...defaultMeta, 'aws.durable.operation_name': operationName },
        })
        assert.match(matched.meta?.['aws.durable.operation_id'] ?? '', OPERATION_ID_RE)
      })
      await invokeHandler(async (event, ctx) => run(ctx), opts)
      return trace
    })
  }

  it('aws.durable.step (un-named overload): omits operation_name when no name is passed', async () => {
    const trace = agent.assertSomeTraces(traces => {
      const matched = assertSpanByName(traces, {
        name: 'aws.durable.step',
        resource: 'aws.durable.step',
        meta: defaultMeta,
      })
      assert.equal(matched.meta?.['aws.durable.operation_name'], undefined,
        'aws.durable.operation_name must be absent when no name is passed')
      assert.match(matched.meta?.['aws.durable.operation_id'] ?? '', OPERATION_ID_RE)
    })
    await invokeHandler(async (event, ctx) => ctx.step(async () => {}))
    return trace
  })

  for (const { span, errorMessage, run } of [
    {
      span: 'aws.durable.step',
      errorMessage: 'Intentional step error',
      run: ctx => ctx.step('error-step',
        async () => { throw new Error('Intentional step error') },
        { retryStrategy: () => ({ shouldRetry: false }) }),
    },
    {
      span: 'aws.durable.child_context',
      errorMessage: 'Intentional child context error',
      run: ctx => ctx.runInChildContext('error-child',
        async () => { throw new Error('Intentional child context error') },
        { retryStrategy: () => ({ shouldRetry: false }) }),
    },
  ]) {
    it(`${span} (error path): stamps error tags on span`, async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: span,
        meta: {
          component: COMPONENT,
          'span.kind': 'internal',
          'error.type': 'Error',
          'error.message': errorMessage,
        },
        error: 1,
      }))
      try {
        await invokeHandler(async (event, ctx) => run(ctx))
      } catch { /* expected */ }
      return trace
    })
  }

  // map/parallel suppress internal child_context spans and force the default resource on
  // direct step children to avoid unbounded resource-tag cardinality.
  describe('aws.durable.map', () => {
    const runMap = () => invokeHandler(async (event, ctx) =>
      ctx.map('items', [1, 2], async (mapCtx, item) =>
        mapCtx.step(`work-${item}`, async () => {})))

    it('suppresses internal child_context spans', async () => {
      const trace = agent.assertSomeTraces(traces => {
        assert.equal(traces.flat().filter(s => s.name === 'aws.durable.child_context').length, 0)
      })
      await runMap()
      return trace
    })

    it('step children keep default resource and carry operation_name', async () => {
      const trace = agent.assertSomeTraces(
        traces => assertStepChildren(traces, 'aws.durable.map', ['work-1', 'work-2'])
      )
      await runMap()
      return trace
    })
  })

  describe('aws.durable.parallel', () => {
    const runParallel = () => invokeHandler(async (event, ctx) =>
      ctx.parallel('fan-out', [
        async pCtx => pCtx.step('a', async () => {}),
        async pCtx => pCtx.step('b', async () => {}),
      ]))

    it('suppresses internal child_context spans', async () => {
      const trace = agent.assertSomeTraces(traces => {
        assert.equal(traces.flat().filter(s => s.name === 'aws.durable.child_context').length, 0)
      })
      await runParallel()
      return trace
    })

    it('step children keep default resource and carry operation_name', async () => {
      const trace = agent.assertSomeTraces(traces => assertStepChildren(traces, 'aws.durable.parallel', ['a', 'b']))
      await runParallel()
      return trace
    })
  })

  describe('DurableContextImpl.invoke() - aws.durable.invoke', () => {
    it('happy: emits function_name, operation_name and operation_id with span.kind=client', async () => {
      const trace = agent.assertSomeTraces(traces => {
        const matched = assertSpanByName(traces, {
          name: 'aws.durable.invoke',
          resource: 'test-func',
          meta: {
            component: COMPONENT,
            'span.kind': 'client',
            'aws.durable.invoke.function_name': TEST_FUNC_ARN,
            'aws.durable.replayed': 'false',
            'aws.durable.operation_name': 'test-func',
          },
        })
        assert.match(matched.meta?.['aws.durable.operation_id'] ?? '', OPERATION_ID_RE)
      })

      const result = await invokeHandler(
        async (event, ctx) => ctx.invoke('test-func', TEST_FUNC_ARN, {}),
        { invokeTarget: async () => {} }
      )
      assert.ok(result !== undefined, 'invoke should return a result')

      return trace
    })

    it('error: stamps error tags when invoke target fails', async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.invoke',
        meta: {
          component: COMPONENT,
          'span.kind': 'client',
          'error.type': 'Error',
          'error.message': 'Intentional invoke error',
        },
        error: 1,
      }))

      try {
        await invokeHandler(
          async (event, ctx) => ctx.invoke('error-func', TEST_FUNC_ARN, {}),
          { invokeTarget: async () => { throw new Error('Intentional invoke error') } }
        )
      } catch { /* expected */ }

      return trace
    })
  })

  it('checkpoint plugin: fail-then-succeed retry produces a span per attempt', async () => {
    const failedAttemptSpan = agent.assertSomeTraces(traces => assertSpanByName(traces, {
      name: 'aws.durable.step',
      resource: 'retry-step',
      meta: { 'error.type': 'Error', 'error.message': 'transient failure' },
      error: 1,
    }))
    const succeededAttemptSpan = agent.assertSomeTraces(traces => {
      const span = traces.flat().find(s =>
        s.name === 'aws.durable.step' && s.resource === 'retry-step'
      )
      assert.ok(span, 'expected step span')
      assert.notEqual(span.error, 1, 'successful retry attempt must not be tagged as errored')
    }, { timeoutMs: 5000 })
    const successfulExecuteSpan = agent.assertSomeTraces(traces => assertSpanByName(traces, {
      name: 'aws.durable.execute',
      meta: { 'aws.durable.invocation_status': 'succeeded' },
    }), { timeoutMs: 5000 })

    let attempts = 0
    await invokeHandler(async (event, ctx) => ctx.step(
      'retry-step',
      async () => {
        attempts++
        if (attempts === 1) throw new Error('transient failure')
      },
      { retryStrategy: () => ({ shouldRetry: true, delay: { seconds: 1 } }) }
    ))
    assert.equal(attempts, 2, 'expected the step body to be called twice (initial + retry)')

    return Promise.all([failedAttemptSpan, succeededAttemptSpan, successfulExecuteSpan])
  })
})
