'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { NODE_MAJOR } = require('../../../version')

// @aws/durable-execution-sdk-js >=1.1.0 (our minimum supported version) requires Node.js >=22.
if (NODE_MAJOR < 22) return

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
  const byName = traces.flat().filter(s => s.name === expected.name)
  const span = byName.find(s =>
    Object.entries(expected.meta ?? {}).every(([k, v]) => s.meta?.[k] === v)
  )
  assert.ok(span, `expected span matching ${inspect(expected)}, got: ${inspect(byName)}`)
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
      const tracePromise = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: {
          ...defaultMeta,
          'aws.durable.invocation_status': 'succeeded',
        },
      }))

      const result = await invokeHandler(async () => {})
      assert.notStrictEqual(result, undefined, 'withDurableExecution should return a result')

      return tracePromise
    })

    it('error: invocation_status=failed when handler throws', async () => {
      const tracePromise = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: { component: COMPONENT, 'aws.durable.invocation_status': 'failed' },
      }))

      // The SDK catches handler errors and returns FAILED without rethrowing.
      await invokeHandler(async () => { throw new Error('Intentional durable execution error') })

      return tracePromise
    })

    // ctx.wait suspends invocation, reinvoked after waiting with replayed=true
    it('replay: replayed=true on resume after suspend', async () => {
      const tracePromise = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: { 'aws.durable.replayed': 'true' },
      }), { timeoutMs: 5000 })

      let invocations = 0
      await invokeHandler(async (event, ctx) => {
        invocations++
        await ctx.wait('replay-trigger', { seconds: 1 })
      })
      assert.equal(invocations, 2, 'expected the handler to be invoked twice (initial + replay)')

      return tracePromise
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
      run: ctx => ctx.waitForCondition('test-condition', async () => 'done', {
        initialState: 'pending',
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
      const tracePromise = agent.assertSomeTraces(traces => {
        const matched = assertSpanByName(traces, {
          name: span,
          resource: operationName,
          meta: { ...defaultMeta, 'aws.durable.operation_name': operationName },
        })
        assert.match(matched.meta?.['aws.durable.operation_id'] ?? '', OPERATION_ID_RE)
        assert.notEqual(matched.error, 1, `${span} happy path should not be errored`)
      })
      await invokeHandler(async (event, ctx) => run(ctx), opts)
      return tracePromise
    })
  }

  it('aws.durable.step (un-named overload): omits operation_name when no name is passed', async () => {
    const tracePromise = agent.assertSomeTraces(traces => {
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
    return tracePromise
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
      const tracePromise = agent.assertSomeTraces(traces => assertSpanByName(traces, {
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
      return tracePromise
    })
  }

  // map/parallel suppress internal child_context spans and force the default resource on
  // direct step children to avoid unbounded resource-tag cardinality.
  describe('aws.durable.map', () => {
    const runMap = () => invokeHandler(async (event, ctx) =>
      ctx.map('items', [1, 2], async (mapCtx, item) =>
        mapCtx.step(`work-${item}`, async () => {})))

    it('suppresses internal child_context spans', async () => {
      const tracePromise = agent.assertSomeTraces(traces => {
        assert.equal(traces.flat().filter(s => s.name === 'aws.durable.child_context').length, 0)
      })
      await runMap()
      return tracePromise
    })

    it('step children keep default resource and carry operation_name', async () => {
      const tracePromise = agent.assertSomeTraces(
        traces => assertStepChildren(traces, 'aws.durable.map', ['work-1', 'work-2'])
      )
      await runMap()
      return tracePromise
    })
  })

  describe('aws.durable.parallel', () => {
    const runParallel = () => invokeHandler(async (event, ctx) =>
      ctx.parallel('fan-out', [
        async pCtx => pCtx.step('a', async () => {}),
        async pCtx => pCtx.step('b', async () => {}),
      ]))

    it('suppresses internal child_context spans', async () => {
      const tracePromise = agent.assertSomeTraces(traces => {
        assert.equal(traces.flat().filter(s => s.name === 'aws.durable.child_context').length, 0)
      })
      await runParallel()
      return tracePromise
    })

    it('step children keep default resource and carry operation_name', async () => {
      const tracePromise = agent.assertSomeTraces(
        traces => assertStepChildren(traces, 'aws.durable.parallel', ['a', 'b'])
      )
      await runParallel()
      return tracePromise
    })
  })

  describe('DurableContextImpl.invoke() - aws.durable.invoke', () => {
    it('happy: emits function_name, operation_name and operation_id with span.kind=client', async () => {
      const tracePromise = agent.assertSomeTraces(traces => {
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
      assert.notStrictEqual(result, undefined, 'invoke should return a result')

      return tracePromise
    })

    it('error: stamps error tags when invoke target fails', async () => {
      const tracePromise = agent.assertSomeTraces(traces => assertSpanByName(traces, {
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

      return tracePromise
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

  // Regression coverage for the SDK "safe paths" the trace-checkpoint hook relies on
  // (see packages/datadog-plugin-aws-durable-execution-sdk-js/src/trace-checkpoint.js).
  // These exercise the real @aws/durable-execution-sdk-js + @aws/durable-execution-sdk-js-testing
  // version pinned in packages/dd-trace/test/plugins/versions/package.json. If an SDK upgrade
  // starts iterating all stepData entries, drops the chronological Operations[0] guarantee,
  // or routes our blake2b-hashed stepIds through the user-step lifecycle map, one of these
  // will fail and tell us exactly which assumption broke.
  describe('trace-checkpoint propagation (SDK safe-path coverage)', () => {
    const CHECKPOINT_NAME_RE = /^_datadog_\d+$/

    const checkpointOps = (result) =>
      result.getOperations().filter(op => CHECKPOINT_NAME_RE.test(op.getName() ?? ''))

    const parseCheckpointHeaders = (op) => {
      const data = op.getOperationData()
      const payload = data?.Payload ?? data?.StepDetails?.Result
      return typeof payload === 'string' ? JSON.parse(payload) : null
    }

    // Safe paths covered: stepData namespace isolation (getStepData lookups by user-code
    // sequential stepIds never hit our blake2b-hashed entries) and Operations[0] ordering
    // (the customer's original payload remains reachable on resume even though our
    // _datadog_* op is appended to InitialExecutionState.Operations).
    //
    // NB: This test does NOT assert trace_id continuity across initial and replay
    // spans. The dd-trace integration only persists the checkpoint; the extraction
    // layer that seeds the resumed invocation with the saved context lives in
    // datadog-lambda-js (the upstream wrapper), which isn't loaded in this harness.
    // See dd-trace-py tests/contrib/aws_durable_execution_sdk_python/
    // test_aws_durable_execution_sdk_python.py docstring for the parallel reasoning.
    it('single cycle: writes _datadog_0, preserves customer payload across resume', async () => {
      const replayExecute = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: { 'aws.durable.replayed': 'true' },
      }), { timeoutMs: 5000 })

      const handlerInputs = []
      const result = await invokeHandler(async (event, ctx) => {
        handlerInputs.push(event)
        await ctx.wait('checkpoint-trigger', { seconds: 1 })
      })

      assert.equal(handlerInputs.length, 2, 'handler should run on initial invocation and resume')
      for (const ev of handlerInputs) {
        assertObjectContains(ev, { testInput: true })
      }

      const saved = checkpointOps(result)
      assert.ok(saved.length >= 1, `expected a _datadog_ checkpoint op, got names: ${
        result.getOperations().map(o => o.getName()).join(', ')}`)
      const headers = parseCheckpointHeaders(saved[0])
      assert.ok(headers?.['x-datadog-trace-id'], 'checkpoint payload should carry x-datadog-trace-id')
      assert.ok(headers?.['x-datadog-parent-id'], 'checkpoint payload should carry x-datadog-parent-id')
      // Checkpoints are written and read entirely by Datadog code, so we force
      // datadog-only injection regardless of the user's propagation-style config.
      assert.equal(headers?.traceparent, undefined,
        'tracecontext headers must not be persisted — checkpoints are datadog-style only')
      assert.equal(headers?.tracestate, undefined,
        'tracestate must not be persisted — checkpoints are datadog-style only')

      return replayExecute
    })

    // Safe path covered: hasFinishedAncestor() in CheckpointManager parses stepIds by
    // splitting on `-`. Our 64-char hex blake2b stepIds contain no `-`, so even when the
    // suspend happens inside runInChildContext (whose own child stepIds DO use `-`),
    // ancestor-finished pruning never targets our checkpoint write.
    it('child-context: checkpoint still saves when suspend happens inside runInChildContext', async () => {
      const replayExecute = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: { 'aws.durable.replayed': 'true' },
      }), { timeoutMs: 5000 })

      const result = await invokeHandler(async (event, ctx) =>
        ctx.runInChildContext('child', async cctx => cctx.wait('child-wait', { seconds: 1 })))

      assert.ok(checkpointOps(result).length >= 1,
        'a _datadog_ checkpoint must save even when the suspend originates inside runInChildContext')

      return replayExecute
    })

    // Safe paths covered: this.operations lifecycle map (checkAndTerminate / cleanupAllOperations
    // never see us) and validateReplayConsistency (per-stepId, called only with user stepIds).
    // A real step before AND after a suspend forces the SDK to (1) validateReplayConsistency
    // against the prior step's stored entry, (2) walk through REPLAY → ExecutionMode while our
    // _datadog_0 sits in stepData, and (3) start a fresh user step after the transition. Any
    // leakage of our blake2b-hashed entries into those checks would surface as
    // NonDeterministicExecutionError or a hung termination.
    it('step-suspend-step: replay-validation runs around our _datadog_0 without errors', async () => {
      const succeededExecute = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: { 'aws.durable.invocation_status': 'succeeded' },
      }), { timeoutMs: 5000 })

      const stepInvocations = { before: 0, after: 0 }
      const result = await invokeHandler(async (event, ctx) => {
        await ctx.step('before', async () => { stepInvocations.before++ })
        await ctx.wait('mid-wait', { seconds: 1 })
        await ctx.step('after', async () => { stepInvocations.after++ })
      })

      assert.equal(stepInvocations.before, 1, "'before' step body must run exactly once across replay")
      assert.equal(stepInvocations.after, 1, "'after' step body must run exactly once after the suspend resume")
      assert.ok(checkpointOps(result).length >= 1,
        'expected at least one _datadog_ checkpoint op across the suspend cycle')

      return succeededExecute
    })
  })
})
