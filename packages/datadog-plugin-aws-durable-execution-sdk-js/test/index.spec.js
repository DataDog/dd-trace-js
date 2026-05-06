'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { TEST_EXEC_ARN, TEST_FUNC_ARN, invokeHandler, setup, teardown } = require('./helpers')

const COMPONENT = 'aws-durable-execution-sdk-js'
const defaultMeta = {
  component: COMPONENT,
  'span.kind': 'internal',
  'aws.durable.replayed': 'false',
}

/** Find a span by name across all received traces and assert it contains expected props. */
function assertSpanByName (traces, expected) {
  const allSpans = traces.flat()
  const span = allSpans.find(s => s.name === expected.name)
  if (!span) {
    const names = allSpans.map(s => s.name)
    throw new Error(`Expected span "${expected.name}" not found. Available: ${JSON.stringify(names)}`)
  }
  assertObjectContains(span, expected)
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

  before(async () => setup(meta.mod))
  after(async () => teardown())

  describe('withDurableExecution() - aws.durable.execute', () => {
    it('happy: emits execution_arn, invocation_status=succeeded, replayed=false', async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: {
          ...defaultMeta,
          'aws.durable.execution_arn': TEST_EXEC_ARN,
          'aws.durable.invocation_status': 'succeeded',
        },
      }))

      const result = await invokeHandler(async () => ({ status: 'completed' }), { mode: 'immediate' })
      assert.ok(result !== undefined, 'withDurableExecution should return a result')

      return trace
    })

    it('error: invocation_status=failed when handler throws', async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: { component: COMPONENT, 'aws.durable.invocation_status': 'failed' },
      }))

      // The SDK catches handler errors and returns FAILED without rethrowing.
      await invokeHandler(async () => { throw new Error('Intentional durable execution error') },
        { mode: 'immediate' })

      return trace
    })

    it('replay: replayed=true when event has prior operations', async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.execute',
        meta: { 'aws.durable.replayed': 'true' },
      }))

      // >1 Operations on the event signals the SDK to enter ReplayMode.
      const replayOp = {
        Id: crypto.createHash('md5').update('1').digest('hex').substring(0, 16),
        Type: 'STEP',
        SubType: 'STEP',
        Status: 'SUCCEEDED',
        Name: 'prior-step',
        StepDetails: { Result: JSON.stringify('cached') },
      }
      await invokeHandler(async () => ({ status: 'replayed' }),
        { mode: 'immediate', extraOps: [replayOp] })

      return trace
    })
  })

  // 7 of 9 spans share BaseAwsDurableExecutionSdkJsContextPlugin.bindStart.
  // One smoke test per span name proves orchestrion's prefix → spanName wiring.
  for (const { span, resource, run, mode } of [
    { span: 'aws.durable.step', resource: 'test-step',
      run: ctx => ctx.step('test-step', async () => ({ stepped: true })) },
    { span: 'aws.durable.child_context',
      run: ctx => ctx.runInChildContext('test-child', async () => ({ childResult: true })) },
    { span: 'aws.durable.wait', mode: 'immediate',
      run: ctx => ctx.wait('test-wait', { seconds: 1 }) },
    { span: 'aws.durable.wait_for_condition',
      run: ctx => ctx.waitForCondition('test-condition', async () => ({ met: true }), {
        waitStrategy: r => r?.met
          ? { shouldContinue: false }
          : { shouldContinue: true, delay: { seconds: 1 } },
      }) },
    { span: 'aws.durable.wait_for_callback',
      run: ctx => ctx.waitForCallback('test-callback', async () => ({ submitted: true })) },
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
      await invokeHandler(async (event, ctx) => run(ctx), mode ? { mode } : undefined)
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
      }, { mode: 'immediate' })

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
        { mode: 'immediate' }
      )
      assert.ok(result !== undefined, 'invoke should return a result')

      return trace
    })

    it('error: stamps error tags when checkpoint START fails', async () => {
      const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
        name: 'aws.durable.invoke',
        meta: {
          component: COMPONENT,
          'span.kind': 'client',
          'error.type': 'InvokeError',
          'error.message': 'Intentional invoke error',
        },
        error: 1,
      }))

      try {
        await invokeHandler(
          async (event, ctx) => ctx.invoke(
            'error-func', 'arn:aws:lambda:us-east-1:123456789012:function:nonexistent', {}
          ),
          { mode: 'immediate', failOnAction: 'START' }
        )
      } catch { /* expected */ }

      return trace
    })
  })

  // The SDK queues a RETRY checkpoint with the user's error and awaits a retry timer.
  // The retry-pending mode keeps RETRY ops PENDING so the SDK suspends (terminationManager
  // wins the race) instead of looping. The checkpoint plugin sees the RETRY action and
  // stamps the user error onto the active step span.
  it('checkpoint plugin: attaches user error to step span when RETRY is queued', async () => {
    const trace = agent.assertSomeTraces(traces => assertSpanByName(traces, {
      name: 'aws.durable.step',
      resource: 'retry-step',
      meta: { 'error.type': 'Error', 'error.message': 'transient failure' },
      error: 1,
    }))

    try {
      await invokeHandler(
        async (event, ctx) => ctx.step('retry-step',
          async () => { throw new Error('transient failure') },
          { retryStrategy: () => ({ shouldRetry: true, delay: { seconds: 60 } }) }),
        { mode: 'retry-pending' }
      )
    } catch { /* the workflow may suspend (PENDING) — not an error to the caller */ }

    return trace
  })
})
