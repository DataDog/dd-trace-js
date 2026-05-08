'use strict'

const assert = require('node:assert/strict')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { TEST_FUNC_ARN, invokeHandler, setup, teardown } = require('./helpers')

const COMPONENT = 'aws-durable-execution-sdk-js'
const defaultMeta = {
  component: COMPONENT,
  'span.kind': 'internal',
  'aws.durable.replayed': 'false',
}

/**
 * Find a span matching the expected name and partial-equal-match all expected fields.
 * Iterates same-named candidates so multi-invocation flows (e.g. replay) can pick the
 * right span, falling back to the last assertion error for a clear diff.
 */
function assertSpanByName (traces, expected) {
  const allSpans = traces.flat()
  const candidates = allSpans.filter(s => s.name === expected.name)
  if (candidates.length === 0) {
    const names = allSpans.map(s => s.name)
    throw new Error(`Expected span "${expected.name}" not found. Available: ${JSON.stringify(names)}`)
  }
  let lastErr
  for (const span of candidates) {
    try {
      assertObjectContains(span, expected)
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

/**
 * Asserts map/parallel child suppression: no child_context spans in the parent's trace,
 * and direct step children keep the default resource (cardinality protection).
 */
function assertChildSuppression (traces, parentSpanName, op) {
  const allSpans = traces.flat()
  const parentSpan = allSpans.find(s => s.name === parentSpanName)
  if (!parentSpan) throw new Error(`${parentSpanName} span not found`)
  const traceId = parentSpan.trace_id?.toString()

  const childContextSpans = allSpans.filter(s =>
    s.name === 'aws.durable.child_context' && s.trace_id?.toString() === traceId
  )
  assert.equal(childContextSpans.length, 0, `expected no child_context spans inside ${op}`)

  const stepChildren = allSpans.filter(s =>
    s.name === 'aws.durable.step' && s.parent_id?.toString() === parentSpan.span_id?.toString()
  )
  assert.ok(stepChildren.length >= 2, `expected step children directly under ${op}`)
  for (const step of stepChildren) {
    assert.equal(step.resource, 'aws.durable.step', `expected default resource on ${op} child step`)
  }
}

createIntegrationTestSuite('aws-durable-execution-sdk-js', '@aws/durable-execution-sdk-js', {
  category: 'orchestration',
}, (meta) => {
  const { agent } = meta

  // setup/teardown per-test so the fake clock (static on LocalDurableTestRunner) starts
  // fresh — otherwise time advanced by ctx.wait/RETRY in earlier tests can let later
  // ctx.wait calls complete synchronously and skip the suspend/replay cycle.
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

      const result = await invokeHandler(async () => ({ status: 'completed' }))
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

    // ctx.wait suspends the first invocation; under skipTime the runner advances virtual
    // time and re-invokes the handler. The second invocation enters ReplayMode naturally,
    // so its aws.durable.execute span carries replayed=true. Same trick dd-trace-py uses.
    // The wider timeout absorbs the gap between the first (PENDING) trace flush and the
    // second (replayed) flush — both arrive in separate payloads.
    it('replay: replayed=true on resume after suspend', async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: { 'aws.durable.replayed': 'true' },
      }), { timeoutMs: 5000 })

      let invocations = 0
      await invokeHandler(async (event, ctx) => {
        invocations++
        await ctx.wait('replay-trigger', { seconds: 1 })
        return { status: 'replayed' }
      })
      assert.equal(invocations, 2, 'expected the handler to be invoked twice (initial + replay)')

      return trace
    })
  })

  // 7 of 9 spans share BaseAwsDurableExecutionSdkJsContextPlugin.bindStart.
  // One smoke test per span name proves orchestrion's prefix → spanName wiring.
  for (const { span, resource, run, opts } of [
    { span: 'aws.durable.step', resource: 'test-step',
      run: ctx => ctx.step('test-step', async () => ({ stepped: true })) },
    { span: 'aws.durable.child_context',
      run: ctx => ctx.runInChildContext('test-child', async () => ({ childResult: true })) },
    { span: 'aws.durable.wait',
      run: ctx => ctx.wait('test-wait', { seconds: 1 }) },
    { span: 'aws.durable.wait_for_condition',
      run: ctx => ctx.waitForCondition('test-condition', async () => ({ met: true }), {
        waitStrategy: r => r?.met
          ? { shouldContinue: false }
          : { shouldContinue: true, delay: { seconds: 1 } },
      }) },
    { span: 'aws.durable.wait_for_callback',
      run: ctx => ctx.waitForCallback('test-callback', async () => ({ submitted: true })),
      opts: { resolveCallback: 'test-callback' } },
    { span: 'aws.durable.create_callback',
      run: ctx => ctx.createCallback('test-create-cb') },
    { span: 'aws.durable.map',
      run: ctx => ctx.map('test-map', [1, 2, 3], async (item) => item * 2) },
    { span: 'aws.durable.parallel',
      run: ctx => ctx.parallel('test-parallel',
        [async () => 'branch-a', async () => 'branch-b']) },
  ]) {
    it(`${span} (happy path): emits span with default meta`, async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: span, ...(resource && { resource }), meta: defaultMeta,
      }))
      await invokeHandler(async (event, ctx) => run(ctx), opts)
      return trace
    })
  }

  // Error coverage for the shared base. Both step and child_context propagate user errors
  // through `BaseAwsDurableExecutionSdkJsContextPlugin.error()`. The SDK wraps the user's
  // `Error` into a typed error class (StepError / ChildContextError) before reaching the
  // plugin, which is why `error.type` differs from `'Error'`.
  for (const { span, errorType, errorMessage, run } of [
    { span: 'aws.durable.step', errorType: 'StepError', errorMessage: 'Intentional step error',
      run: ctx => ctx.step('error-step',
        async () => { throw new Error('Intentional step error') },
        { retryStrategy: () => ({ shouldRetry: false }) }) },
    { span: 'aws.durable.child_context', errorType: 'ChildContextError',
      errorMessage: 'Intentional child context error',
      run: ctx => ctx.runInChildContext('error-child',
        async () => { throw new Error('Intentional child context error') },
        { retryStrategy: () => ({ shouldRetry: false }) }) },
  ]) {
    it(`${span} (error path): stamps error tags on span`, async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: span,
        meta: { component: COMPONENT, 'span.kind': 'internal',
          'error.type': errorType, 'error.message': errorMessage },
        error: 1,
      }))
      try {
        await invokeHandler(async (event, ctx) => run(ctx))
      } catch { /* expected */ }
      return trace
    })
  }

  // map/parallel suppress internal child_context spans and force the default resource on
  // direct step children to avoid resource-tag cardinality explosions.
  for (const op of ['map', 'parallel']) {
    const spanName = `aws.durable.${op}`
    it(`${spanName}: suppresses child_context and keeps default step resource`, async () => {
      const trace = agent.assertSomeTraces(traces => assertChildSuppression(traces, spanName, op))

      await invokeHandler(async (event, ctx) => {
        if (op === 'map') {
          return ctx.map('items', [1, 2], async (mapCtx, item) =>
            mapCtx.step(`work-${item}`, async () => item * 2))
        }
        return ctx.parallel('fan-out', [
          async pCtx => pCtx.step('a', async () => 'a-result'),
          async pCtx => pCtx.step('b', async () => 'b-result'),
        ])
      })

      return trace
    })
  }

  describe('DurableContextImpl.invoke() - aws.durable.invoke', () => {
    it('happy: emits function_name with span.kind=client', async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.invoke',
        resource: 'test-func',
        meta: {
          component: COMPONENT,
          'span.kind': 'client',
          'aws.durable.invoke.function_name': TEST_FUNC_ARN,
          'aws.durable.replayed': 'false',
        },
      }))

      const result = await invokeHandler(
        async (event, ctx) => ctx.invoke('test-func', TEST_FUNC_ARN, {}),
        { invokeTarget: async () => ({ ok: true }) }
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
          'error.type': 'InvokeError',
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

  // The SDK queues a RETRY checkpoint with the user's error and awaits a retry timer.
  // First call to retryStrategy returns shouldRetry: true so the SDK emits a RETRY
  // checkpoint (the checkpoint plugin sees it and stamps the user error onto the active
  // step span); subsequent calls return shouldRetry: false so the step terminates instead
  // of looping forever under skipTime.
  it('checkpoint plugin: attaches user error to step span when RETRY is queued', async () => {
    const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
      name: 'aws.durable.step',
      resource: 'retry-step',
      meta: { 'error.type': 'Error', 'error.message': 'transient failure' },
      error: 1,
    }))

    let attempts = 0
    try {
      await invokeHandler(
        async (event, ctx) => ctx.step('retry-step',
          async () => { throw new Error('transient failure') },
          { retryStrategy: () => ({ shouldRetry: attempts++ < 1, delay: { seconds: 60 } }) })
      )
    } catch { /* expected: step ultimately fails */ }

    return trace
  })
})
