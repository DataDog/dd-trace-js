'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { HANDLER_STREAMING, STREAM_RESPONSE } = require('../../../datadog-instrumentations/src/helpers/lambda-handler')
const agent = require('../plugins/agent')
const stepEvent = require('../../../datadog-plugin-aws-lambda/test/fixtures/legacy-step-function-event.json')
const { assertExactlyOneLambdaSpan } = require('./helpers')

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64')
const headers = { 'x-datadog-trace-id': '1234', 'x-datadog-parent-id': '5678', 'x-datadog-sampling-priority': '2' }
const customParent = { traceId: '1234', parentId: '5678', sampleMode: 2, source: 'event' }
const sqs = carrier => ({
  eventSource: 'aws:sqs',
  messageAttributes: { _datadog: { stringValue: JSON.stringify(carrier) } },
})
const sns = { Type: 'String', Value: JSON.stringify(headers) }
const msk = carrier => ({
  headers: Object.entries(carrier).map(([key, value]) => ({ [key]: [...Buffer.from(value)] })),
})
const w3c = { traceparent: '00-0123456789abcdef00000000000004d2-000000000000162e-01', tracestate: 'dd=s:2' }

describe('Lambda facade context extraction', () => {
  let tracer
  let facade
  let traces
  let exporter
  let clock
  const oldEnv = process.env
  const context = { functionName: 'extraction-test', getRemainingTimeInMillis: () => 30_000 }

  beforeEach(async () => {
    process.env = { ...oldEnv, AWS_LAMBDA_FUNCTION_NAME: 'extraction-test', DD_TRACE_ENABLED: 'true' }
    delete process.env._X_AMZN_TRACE_ID
    delete process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT
    delete process.env.DD_MERGE_XRAY_TRACES
    tracer = await agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' } })
    // agent.load may rebuild the tracer between specs; refresh the public facade with that instance.
    delete require.cache[require.resolve('../../src/lambda/facade')]
    delete require.cache[require.resolve('../../../../lambda')]
    facade = require('../../../../lambda')
    traces = []
    exporter = sinon.stub(tracer._tracer._exporter, 'export').callsFake(trace => traces.push(trace))
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(async () => {
    clock.restore()
    exporter.restore()
    process.env = oldEnv
    await agent.close({ ritmReset: false })
  })

  async function invoke (event, options, lambdaContext = context) {
    const wrapped = facade.wrap(() => {
      const active = tracer.scope().active()
      assert.ok(active)
      tracer.trace('child', () => {})
      return facade.getTraceHeaders()
    }, options)
    const result = await wrapped(event, lambdaContext)
    const span = assertExactlyOneLambdaSpan(traces)
    const child = traces.flat().find(span => span.name === 'child')
    assert.strictEqual(child.parent_id.toString(10), span.span_id.toString(10))
    assert.strictEqual(child.trace_id.toString(10), span.trace_id.toString(10))
    assert.strictEqual(result['x-datadog-trace-id'], span.trace_id.toString(10))
    assert.strictEqual(result['x-datadog-parent-id'], span.span_id.toString(10))
    assert.strictEqual(clock.countTimers(), 0)
    return span
  }

  for (const [name, event] of [
    ['HTTP', { headers }],
    ['ALB multi-value', {
      requestContext: { elb: {} },
      multiValueHeaders: Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toUpperCase(), [value, 'ignored']])),
    }],
    ['Function URL', { requestContext: { domainName: 'test.lambda-url.aws' }, headers }],
    ['SNS', { Records: [{ Sns: { MessageAttributes: { _datadog: sns } } }] }],
    ['SNS-SQS', {
      Records: [{
        ...sqs({}),
        body: JSON.stringify({
          Type: 'Notification',
          TopicArn: 'topic',
          MessageAttributes: { _datadog: sns },
        }),
      }],
    }],
    ['EventBridge-SQS', {
      Records: [{
        ...sqs({}),
        body: JSON.stringify({
          'detail-type': 'test',
          detail: { _datadog: headers },
        }),
      }],
    }],
    ['AppSync', { info: { selectionSetGraphQL: '{}' }, request: { headers } }],
    ['MSK', { eventSource: 'aws:kafka', records: { topic: [{ headers: [] }, msk(headers)] } }],
    ['SQS', { Records: [sqs(headers)] }],
    ['Kinesis', { Records: [{ kinesis: { data: encode({ _datadog: headers }) } }] }],
    ['EventBridge', { 'detail-type': 'test', detail: { _datadog: headers } }],
    ['Durable', {
      DurableExecutionArn: 'arn',
      InitialExecutionState: {
        Operations: [
          { Name: '_datadog_1', Payload: JSON.stringify(headers) },
        ],
      },
    }],
    ['W3C HTTP', { headers: w3c }],
    ['W3C MSK', { eventSource: 'aws:kafka', records: { topic: [msk(w3c)] } }],
  ]) {
    it(`parents exactly one invocation and its child from ${name}`, async () => {
      const span = await invoke(structuredClone(event))
      assert.strictEqual(span.trace_id.toString(10), '1234')
      assert.strictEqual(span.parent_id.toString(10), '5678')
      assert.strictEqual(span.metrics._sampling_priority_v1, 2)
      assert.strictEqual(span.meta['_dd.parent_source'], 'event')
      if (name.startsWith('W3C')) assert.strictEqual(span.meta['_dd.p.tid'], '0123456789abcdef')
    })
  }

  it('parents from Lambda client context', async () => {
    const span = await invoke({}, {}, { ...context, clientContext: { custom: { _datadog: headers } } })
    assert.strictEqual(span.trace_id.toString(10), '1234')
    assert.strictEqual(span.parent_id.toString(10), '5678')
  })

  it('parents from Step Functions deterministic IDs', async () => {
    const span = await invoke(stepEvent)
    assert.strictEqual(span.trace_id.toString(10), '1139193989631387307')
    assert.strictEqual(span.parent_id.toString(10), '7747304477664363642')
    assert.strictEqual(span.metrics._sampling_priority_v1, 1)
  })

  it('waits for custom extraction before span start or handler execution', async () => {
    let resolve
    let activeDuringExtraction
    const ready = new Promise(_resolve => { resolve = _resolve })
    let called = false
    const wrapped = facade.wrap(() => { called = true; return 'done' }, {
      traceExtractor: async (event, ctx) => {
        assert.strictEqual(ctx, context)
        activeDuringExtraction = tracer.scope().active()
        await ready
        return customParent
      },
    })
    const pending = wrapped({ headers: {} }, context)
    assert.strictEqual(called, false)
    assert.strictEqual(activeDuringExtraction, null)
    assert.strictEqual(traces.length, 0)
    resolve()
    assert.strictEqual(await pending, 'done')
    const span = assertExactlyOneLambdaSpan(traces)
    assert.strictEqual(span.trace_id.toString(10), '1234')
    assert.strictEqual(span.parent_id.toString(10), '5678')
  })

  for (const sampleMode of [-1, 0, 1, 2]) {
    it(`keeps custom sampling numeric through export: ${sampleMode}`, async () => {
      const span = await invoke({}, { traceExtractor: async () => ({ ...customParent, sampleMode }) })
      assert.strictEqual(span.metrics._sampling_priority_v1, sampleMode)
    })
  }

  for (const custom of [() => { throw Error('extraction failed') }, async () => { throw Error('extraction failed') }]) {
    it('contains custom failures and falls back to event propagation', async () => {
      const span = await invoke({ headers }, { traceExtractor: custom })
      assert.strictEqual(span.parent_id.toString(10), '5678')
      assert.strictEqual(span.error, 0)
    })
  }

  it('contains malformed extraction without disabling subsequent invocations', async () => {
    const first = await invoke(null)
    assert.strictEqual(first.parent_id.toString(10), '0')
    traces.length = 0
    const second = await invoke({ headers })
    assert.strictEqual(second.parent_id.toString(10), '5678')
  })

  for (const merge of [false, true]) {
    it(`respects X-Ray merge=${merge}`, async () => {
      process.env._X_AMZN_TRACE_ID = 'Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1'
      const span = await invoke({}, { mergeXrayTraces: merge })
      assert.strictEqual(span.parent_id.toString(10), merge ? '797643193680388254' : '0')
      if (merge) {
        assert.strictEqual(span.trace_id.toString(10), '4110911582297405557')
        assert.strictEqual(span.meta['_dd.parent_source'], 'xray')
        assert.strictEqual(span.metrics._sampling_priority_v1, 2)
      } else assert.strictEqual(span.meta['_dd.parent_source'], undefined)
    })
  }

  for (const [name, options, expectedParent] of [
    ['legacy shim spelling', { mergeDatadogXrayTraces: true }, '797643193680388254'],
    ['canonical spelling precedence', { mergeDatadogXrayTraces: true, mergeXrayTraces: false }, '0'],
  ]) {
    it(`supports the X-Ray ${name}`, async () => {
      process.env._X_AMZN_TRACE_ID = 'Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1'
      const span = await invoke({}, options)
      assert.strictEqual(span.parent_id.toString(10), expectedParent)
    })
  }

  it('inherits extraction configuration from the plugin without leaking per-handler overrides', async () => {
    const custom = sinon.stub().resolves(customParent)
    tracer.use('aws-lambda', { traceExtractor: custom, mergeXrayTraces: true })
    const span = await invoke({})
    assert.strictEqual(span.parent_id.toString(10), '5678')
    traces.length = 0
    const override = await invoke({}, { traceExtractor: () => ({ ...customParent, parentId: '8765' }) })
    assert.strictEqual(override.parent_id.toString(10), '8765')
    sinon.assert.calledOnce(custom)
  })

  it('ignores stale ambient context during extraction and does not leak parents between warm calls', async () => {
    const stale = tracer.startSpan('stale')
    const wrapped = facade.wrap(event => tracer.scope().active().context().toTraceId(), {
      traceExtractor: async event => {
        assert.strictEqual(tracer.scope().active(), null)
        return event.custom
      },
    })
    for (const [event, expected] of [
      [{ custom: customParent }, '1234'], [stepEvent, '1139193989631387307'], [{}, undefined],
      [{ headers }, '1234'], [{}, undefined],
    ]) {
      traces.length = 0
      const traceId = await tracer.scope().activate(stale, () => wrapped(event, context))
      const span = assertExactlyOneLambdaSpan(traces)
      if (expected) assert.strictEqual(traceId, expected)
      else {
        assert.strictEqual(span.parent_id.toString(10), '0')
        assert.notStrictEqual(traceId, stale.context().toTraceId())
      }
    }
    stale.finish()
  })

  it('isolates overlapping awaited extractions', async () => {
    const resolvers = []
    const wrapped = facade.wrap(() => tracer.scope().active().context().toTraceId(), {
      traceExtractor: event => new Promise(resolve => resolvers.push(() => resolve(event))),
    })
    const first = wrapped(customParent, context)
    const second = wrapped({ ...customParent, traceId: '4321' }, context)
    const all = Promise.all([first, second])
    resolvers[1]()
    resolvers[0]()
    assert.deepStrictEqual(await all, ['1234', '4321'])
    assert.strictEqual(traces.flat().filter(span => span.name === 'aws.lambda').length, 2)
  })

  it('preserves callback completion after awaited extraction', async () => {
    const wrapped = facade.wrap((_event, _context, callback) => callback(null, 'callback'), {
      traceExtractor: async () => customParent,
    })
    assert.strictEqual(await wrapped({}, context, () => {}), 'callback')
    assert.strictEqual(assertExactlyOneLambdaSpan(traces).parent_id.toString(10), '5678')
  })

  it('preserves streaming context and the pinned completion helper after awaited extraction', async () => {
    const stream = {}
    const handler = function (event, responseStream, ctx) {
      assert.strictEqual(responseStream, stream)
      assert.strictEqual(ctx, context)
      return Promise.resolve('streamed')
    }
    handler[HANDLER_STREAMING] = STREAM_RESPONSE
    const custom = sinon.stub().resolves(customParent)
    const wrapped = facade.wrap(handler, { traceExtractor: custom })
    assert.strictEqual(await wrapped({}, stream, context), 'streamed')
    sinon.assert.calledOnceWithExactly(custom, {}, context)
    assert.strictEqual(assertExactlyOneLambdaSpan(traces).parent_id.toString(10), '5678')
  })

  it('does not run extraction or create a span while the plugin is disabled', async () => {
    tracer.use('aws-lambda', false)
    const custom = sinon.stub().resolves(customParent)
    const wrapped = facade.wrap(() => 'done', { traceExtractor: custom })
    assert.strictEqual(await wrapped({}, context), 'done')
    sinon.assert.notCalled(custom)
    assert.strictEqual(traces.length, 0)
  })
})
