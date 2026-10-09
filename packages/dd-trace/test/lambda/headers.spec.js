'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const { engines, nodeMaxMajor } = require('../../../../package.json')
const agent = require('../plugins/agent')

const describeSupported = process.env.DD_INJECT_FORCE ||
  semver.satisfies(process.version, `${engines.node} <${nodeMaxMajor}`)
  ? describe
  : describe.skip

describeSupported('Lambda trace headers', () => {
  let tracer
  let lambda
  let oldEnv

  beforeEach(() => {
    oldEnv = process.env
    process.env = {
      ...oldEnv,
      AWS_LAMBDA_FUNCTION_NAME: 'headers-test',
      DD_TRACE_ENABLED: 'true',
    }
    delete process.env.DD_TRACE_PROPAGATION_STYLE
    delete process.env.DD_TRACE_PROPAGATION_STYLE_INJECT
  })

  afterEach(async () => {
    await agent.close()
    process.env = oldEnv
  })

  async function load (config = {}) {
    tracer = await agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' }, ...config })
    // agent.load rebuilds the tracer for each configuration; the public facade must use that instance.
    delete require.cache[require.resolve('../../src/lambda/facade')]
    delete require.cache[require.resolve('../../../../lambda')]
    lambda = require('../../../../lambda')
  }

  for (const [style, carrierKey] of [
    [undefined, 'x-datadog-trace-id'],
    ['datadog', 'x-datadog-trace-id'],
    ['tracecontext', 'traceparent'],
    ['b3multi', 'x-b3-traceid'],
    ['b3 single header', 'b3'],
    ['none', undefined],
  ]) {
    it(`returns exactly the Datadog headers with ${style ?? 'default'} injection`, async () => {
      if (style !== undefined) process.env.DD_TRACE_PROPAGATION_STYLE_INJECT = style
      await load()

      assert.deepStrictEqual(lambda.getTraceHeaders(), {})
      const handler = lambda.wrap(async () => {
        const span = tracer.scope().active()
        assert.ok(span, 'invocation span is active')
        span.setTag('manual.keep', true)
        span.setBaggageItem('example', 'value')
        const context = span.context()
        const before = {}
        tracer.inject(span, 'text_map', before)
        if (carrierKey !== undefined) assert.ok(before[carrierKey], 'the configured injector is active')
        else assert.deepStrictEqual(before, { 'ot-baggage-example': 'value' })

        assert.deepStrictEqual(lambda.getTraceHeaders(), {
          'x-datadog-trace-id': context.toTraceId(),
          'x-datadog-parent-id': context.toSpanId(),
          'x-datadog-sampling-priority': '2',
        })

        const after = {}
        tracer.inject(span, 'text_map', after)
        assert.deepStrictEqual(after, before, 'the facade must not change general-purpose injection')
        return 'done'
      })
      assert.strictEqual(await handler(), 'done')
      assert.deepStrictEqual(lambda.getTraceHeaders(), {})
    })
  }

  for (const priority of [-1, 0, 1, 2]) {
    it(`preserves sampling priority ${priority} and follows an active child span`, async () => {
      process.env.DD_TRACE_PROPAGATION_STYLE_INJECT = 'tracecontext'
      await load({ tracePropagationStyle: { extract: ['datadog'] } })
      const parent = tracer.extract('text_map', {
        'x-datadog-trace-id': '1234',
        'x-datadog-parent-id': '5678',
        'x-datadog-sampling-priority': String(priority),
      })
      tracer.trace('headers.parented', { childOf: parent }, active => {
        const activeHeaders = lambda.getTraceHeaders()
        assert.strictEqual(activeHeaders['x-datadog-trace-id'], '1234')
        assert.strictEqual(activeHeaders['x-datadog-sampling-priority'], String(priority))

        tracer.trace('headers.child', child => {
          assert.notStrictEqual(child.context().toSpanId(), active.context().toSpanId())
          assert.deepStrictEqual(lambda.getTraceHeaders(), {
            'x-datadog-trace-id': '1234',
            'x-datadog-parent-id': child.context().toSpanId(),
            'x-datadog-sampling-priority': String(priority),
          })
        })
        assert.deepStrictEqual(lambda.getTraceHeaders(), activeHeaders)
      })
    })
  }

  it('uses the shim AUTO_KEEP fallback without forcing an undecided sampling decision', async () => {
    await load({ sampleRate: 0 })
    const handler = lambda.wrap(async () => {
      const context = tracer.scope().active().context()
      assert.strictEqual(context._sampling.priority, undefined)
      assert.deepStrictEqual(lambda.getTraceHeaders(), {
        'x-datadog-trace-id': context.toTraceId(),
        'x-datadog-parent-id': context.toSpanId(),
        'x-datadog-sampling-priority': '1',
      })
      assert.strictEqual(context._sampling.priority, undefined, 'reading headers does not sample the trace')
    })
    await handler()
  })
})
