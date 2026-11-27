'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { HANDLER_STREAMING, STREAM_RESPONSE } = require('../../../datadog-instrumentations/src/helpers/lambda-handler')
const agent = require('../plugins/agent')
const { assertExactlyOneLambdaSpan } = require('./helpers')

const fixtures = '../../../datadog-plugin-aws-lambda/test/fixtures/'
const parent = { traceId: '1234', parentId: '5678', sampleMode: 2, source: 'event' }
const finishHeader = 'x-datadog-parent-span-finish-time'
const requestHeader = 'x-datadog-authorizing-requestid'
const invocationContext = {
  functionName: 'inferred-test',
  awsRequestId: 'lambda-request',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:inferred-test:alias',
  getRemainingTimeInMillis: () => 30_000,
}

function event (name) {
  return structuredClone(require(fixtures + name + '.json'))
}

function decode (value) {
  return JSON.parse(Buffer.from(value, 'base64').toString())
}

describe('Lambda inferred span lifecycle', () => {
  const oldEnv = process.env
  const finishChannel = dc.channel('dd-trace:span:finish')
  let tracer, facade, traces, finished, onFinish, clock

  beforeEach(async () => {
    process.env = { ...oldEnv, AWS_LAMBDA_FUNCTION_NAME: 'inferred-test', DD_TRACE_ENABLED: 'true' }
    for (const key of [
      '_X_AMZN_TRACE_ID', 'DD_SERVICE', 'DD_SERVICE_MAPPING', 'DD_TRACE_MANAGED_SERVICES',
      'DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED', 'DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED',
      'DD_ENCODE_AUTHORIZER_CONTEXT', 'DD_DECODE_AUTHORIZER_CONTEXT', 'DD_MERGE_XRAY_TRACES',
    ]) delete process.env[key]
    tracer = await agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' } })
    delete require.cache[require.resolve('../../src/lambda/facade')]
    facade = require('../../src/lambda/facade')
    traces = []
    finished = []
    sinon.stub(tracer._tracer._exporter, 'export').callsFake(trace => traces.push(trace))
    onFinish = span => finished.push(span)
    finishChannel.subscribe(onFinish)
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(async () => {
    clock.restore()
    finishChannel.unsubscribe(onFinish)
    sinon.restore()
    process.env = oldEnv
    await agent.close({ ritmReset: false })
  })

  async function invoke (input, config = {}, handler = () => {
    tracer.trace('child', () => {})
    return { statusCode: 200 }
  }) {
    const wrapped = facade.wrap(handler, config)
    const result = await wrapped(input, { ...invocationContext })
    const lambda = assertExactlyOneLambdaSpan(traces)
    const child = traces.flat().find(span => span.name === 'child')
    if (child) assert.strictEqual(child.parent_id.toString(10), lambda.span_id.toString(10))
    assert.strictEqual(clock.countTimers(), 0)
    return { lambda, result, spans: traces.flat() }
  }

  for (const [fixture, names, isAsync] of [
    ['api-gateway-v1', ['aws.apigateway'], false],
    ['api-gateway-v2', ['aws.httpapi'], false],
    ['api-gateway-wss', ['aws.apigateway'], false],
    ['lambda-function-urls', ['aws.lambda.url'], false],
    ['sns', ['aws.sns'], true],
    ['sqs', ['aws.sqs'], true],
    ['snssqs', ['aws.sns', 'aws.sqs'], true],
    ['eventbridge', ['aws.eventbridge'], true],
    ['eventbridge-sqs', ['aws.eventbridge', 'aws.sqs'], true],
    ['kinesis', ['aws.kinesis'], true],
    ['dynamodb', ['aws.dynamodb'], true],
    ['s3', ['aws.s3'], true],
  ]) {
    it(`preserves the ${fixture} parent chain, sampling, timing and finish order`, async () => {
      const finishTime = 2_000_000_000_000
      if (!isAsync) sinon.stub(Date, 'now').returns(finishTime)
      const { lambda, spans } = await invoke(event(fixture), { traceExtractor: async () => parent })
      const inferred = spans.filter(span => names.includes(span.name))
      assert.strictEqual(inferred.length, names.length)
      assert.deepStrictEqual(inferred.map(span => span.name), names)
      let parentId = '5678'
      for (const span of inferred) {
        assert.strictEqual(span.parent_id.toString(10), parentId)
        assert.strictEqual(span.trace_id.toString(10), '1234')
        assert.strictEqual(span.metrics._sampling_priority_v1, 2)
        assert.strictEqual(span.meta['_inferred_span.synchronicity'], isAsync ? 'async' : 'sync')
        parentId = span.span_id.toString(10)
      }
      assert.strictEqual(lambda.parent_id.toString(10), parentId)
      assert.strictEqual(lambda.meta['_dd.parent_source'], 'event')
      const invocation = finished.find(span => span.context().toSpanId() === lambda.span_id.toString(10))
      const last = finished.find(span => span.context().toSpanId() === parentId)
      assert.ok(finished.indexOf(invocation) < finished.indexOf(last))
      const end = last._startTime + last._duration
      if (isAsync) assert.ok(Math.abs(end - invocation._startTime) < 0.001)
      else assert.strictEqual(end, finishTime)
      if (names.length === 2) {
        const upstream = finished.find(span => span._name === names[0])
        assert.strictEqual(upstream._startTime + upstream._duration, last._startTime)
      }
    })
  }

  it('awaits custom extraction before creating either inferred or invocation spans', async () => {
    let resolve
    const ready = new Promise(_resolve => { resolve = _resolve })
    const handler = sinon.stub().returns('ok')
    const wrapped = facade.wrap(handler, { traceExtractor: async () => { await ready; return parent } })
    const pending = wrapped(event('api-gateway-v1'), { ...invocationContext })
    sinon.assert.notCalled(handler)
    assert.strictEqual(finished.length, 0)
    assert.strictEqual(traces.length, 0)
    resolve()
    assert.strictEqual(await pending, 'ok')
    const lambda = assertExactlyOneLambdaSpan(traces)
    const inferred = traces.flat().find(span => span.name === 'aws.apigateway')
    assert.strictEqual(inferred.parent_id.toString(10), '5678')
    assert.strictEqual(lambda.parent_id.toString(10), inferred.span_id.toString(10))
    sinon.assert.calledOnce(handler)
  })

  for (const source of ['event', 'xray', 'ddtrace']) {
    for (const merge of [false, true]) {
      it(`keeps the ${source} parent behind the inferred span with merge=${merge}`, async () => {
        const { lambda, spans } = await invoke(event('api-gateway-v1'), {
          traceExtractor: () => ({ ...parent, source }), mergeDatadogXrayTraces: merge,
        })
        const inferred = spans.find(span => span.name === 'aws.apigateway')
        const adoptsParent = source === 'event' || merge
        assert.strictEqual(inferred.parent_id.toString(10), adoptsParent ? '5678' : '0')
        if (adoptsParent) assert.strictEqual(inferred.trace_id.toString(10), '1234')
        assert.strictEqual(lambda.parent_id.toString(10), inferred.span_id.toString(10))
        const expectedSource = source === 'event' || (source === 'xray' && merge) ? source : undefined
        assert.strictEqual(lambda.meta['_dd.parent_source'], expectedSource)
      })
    }
  }

  for (const [name, input] of [
    ['ALB', () => event('application-load-balancer')],
    ['AppSync', () => ({ info: { selectionSetGraphQL: '{}' }, request: { headers: {} } })],
    ['Step Functions', () => event('legacy-step-function-event')],
    ['Durable', () => ({ DurableExecutionArn: 'arn', InitialExecutionState: { Operations: [] } })],
    ['MSK', () => ({ eventSource: 'aws:kafka', records: {} })],
    ['custom', () => ({})],
  ]) {
    it(`does not invent an inferred span for ${name}`, async () => {
      const { lambda, spans } = await invoke(input(), { traceExtractor: () => parent })
      assert.strictEqual(lambda.parent_id.toString(10), '5678')
      assert.deepStrictEqual(spans.map(span => span.name), ['aws.lambda', 'child'])
    })
  }

  for (const [name, input] of [
    ['Step Functions', () => event('legacy-step-function-event')],
    ['Durable', () => ({
      DurableExecutionArn: 'arn',
      InitialExecutionState: {
        Operations: [{
          Name: '_datadog_1',
          Payload: JSON.stringify({
            'x-datadog-trace-id': '1234', 'x-datadog-parent-id': '5678', 'x-datadog-sampling-priority': '2',
          }),
        }],
      },
    })],
  ]) {
    it(`preserves extracted ${name} parenting without adding synthetic spans`, async () => {
      const { lambda, spans } = await invoke(input())
      assert.strictEqual(lambda.parent_id.toString(10), name === 'Step Functions' ? '7747304477664363642' : '5678')
      assert.deepStrictEqual(spans.map(span => span.name), ['aws.lambda', 'child'])
    })
  }

  for (const [fixture, name, isAsync] of [
    ['api-gateway-v1', 'aws.apigateway', false],
    ['sqs', 'aws.sqs', true],
  ]) {
    const completions = ['return', 'promise', 'callback', 'throw', 'reject', 'callback error', 'streaming error']
    for (const completion of completions) {
      it(`finishes ${fixture} exactly once on ${completion}`, async () => {
        const failure = Error('customer failure')
        const handler = (_event, _context, callback) => {
          if (completion === 'throw' || completion === 'streaming error') throw failure
          if (completion === 'reject') return Promise.reject(failure)
          if (completion === 'callback error') return callback(failure)
          if (completion === 'callback') return callback(null, 'ok')
          if (completion === 'promise') return Promise.resolve('ok')
          return 'ok'
        }
        const streaming = completion === 'streaming error'
        const customer = completion === 'return' ? () => 'ok' : handler
        if (streaming) customer[HANDLER_STREAMING] = STREAM_RESPONSE
        const wrapped = facade.wrap(customer, { traceExtractor: () => parent })
        const pending = streaming
          ? wrapped(event(fixture), {}, { ...invocationContext })
          : wrapped(event(fixture), { ...invocationContext })
        const failed = ['throw', 'reject', 'callback error', 'streaming error'].includes(completion)
        if (failed) await assert.rejects(pending, error => error === failure)
        else assert.strictEqual(await pending, 'ok')
        const lambda = assertExactlyOneLambdaSpan(traces)
        const inferred = traces.flat().filter(span => span.name === name)
        assert.strictEqual(inferred.length, 1)
        assert.strictEqual(lambda.error, failed ? 1 : 0)
        assert.strictEqual(inferred[0].error, failed && !isAsync ? 1 : 0)
        if (failed && !isAsync) assert.strictEqual(inferred[0].meta['error.message'], 'customer failure')
        assert.deepStrictEqual(finished.map(span => span._name), ['aws.lambda', name])
        assert.strictEqual(clock.countTimers(), 0)
      })
    }
  }

  it('uses the exact source API Gateway async header, with case-sensitive matching', async () => {
    for (const [key, value, expected] of [
      ['X-Amz-Invocation-Type', 'Event', 'async'],
      ['x-amz-invocation-type', 'Event', 'sync'],
      ['X-Amz-Invocation-Type', 'event', 'sync'],
    ]) {
      traces.length = 0
      const input = event('api-gateway-v1')
      input.headers[key] = value
      const { spans } = await invoke(input)
      const inferred = spans.find(span => span.name === 'aws.apigateway')
      assert.strictEqual(inferred.meta['_inferred_span.synchronicity'], expected)
    }
  })

  it('resets inferred parents and errors between warm invocations on the same wrapper', async () => {
    const wrapped = facade.wrap(input => {
      if (input.fail) throw Error('first invocation')
      return 'ok'
    })
    await assert.rejects(wrapped({ ...event('api-gateway-v1'), fail: true }, { ...invocationContext }))
    const first = assertExactlyOneLambdaSpan(traces)
    traces.length = 0
    assert.strictEqual(await wrapped({}, { ...invocationContext }), 'ok')
    const second = assertExactlyOneLambdaSpan(traces)
    assert.strictEqual(second.parent_id.toString(10), '0')
    assert.notStrictEqual(second.trace_id.toString(10), first.trace_id.toString(10))
    assert.strictEqual(second.error, 0)
    assert.strictEqual(traces.flat().length, 1)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('contains inferred-span creation failures and preserves the customer result', async () => {
    const start = sinon.stub(tracer._tracer, 'startSpan').callThrough()
    start.withArgs('aws.apigateway').throws(Error('tracer failure'))
    const { lambda, result, spans } = await invoke(event('api-gateway-v1'), { traceExtractor: () => parent })
    assert.deepStrictEqual(result, { statusCode: 200 })
    assert.strictEqual(lambda.parent_id.toString(10), '5678')
    assert.deepStrictEqual(spans.map(span => span.name), ['aws.lambda', 'child'])
  })

  for (const [name, setup, options, expected] of [
    ['per-handler disable', {}, { createInferredSpan: false }, false],
    ['plugin disable', { createInferredSpan: false }, {}, false],
    ['handler enable over plugin disable', { createInferredSpan: false }, { createInferredSpan: true }, true],
    ['handler disable over plugin enable', { createInferredSpan: true }, { createInferredSpan: false }, false],
  ]) {
    it(`honors ${name}`, async () => {
      tracer.use('aws-lambda', setup)
      const { lambda, spans } = await invoke(event('api-gateway-v1'), { traceExtractor: () => parent, ...options })
      assert.strictEqual(spans.some(span => span.name === 'aws.apigateway'), expected)
      if (!expected) assert.strictEqual(lambda.parent_id.toString(10), '5678')
    })
  }

  for (const [name, env, pluginConfig, handlerConfig, coreConfig, expected] of [
    ['specific mapping', { DD_SERVICE_MAPPING: 'lambda_sqs:generic,MyQueue:specific' }, {}, {}, {}, 'specific'],
    ['generic mapping', { DD_SERVICE_MAPPING: 'lambda_sqs:generic' }, {}, {}, {}, 'generic'],
    ['programmatic mapping', {}, {}, {}, { serviceMapping: { MyQueue: 'programmatic' } }, 'programmatic'],
    ['mapping before removal', {
      DD_SERVICE: 'base',
      DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: 'true',
      DD_SERVICE_MAPPING: 'MyQueue:mapped',
    }, {}, {}, {}, 'mapped'],
    ['base-service removal', {
      DD_SERVICE: '  MixedCase-Base  ',
      DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: 'true',
    }, {}, {}, {}, 'MixedCase-Base'],
    ['generic representation', { DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED: 'false' }, {}, {}, {}, 'sqs'],
    ['handler representation', {}, {}, { serviceRepresentationEnabled: false }, {}, 'sqs'],
    ['handler enable over plugin', {}, { serviceRepresentationEnabled: false },
      { serviceRepresentationEnabled: true }, {}, 'MyQueue'],
    ['identity mapping', { DD_SERVICE_MAPPING: 'lambda_sqs:lambda_sqs' }, {}, {}, {}, 'MyQueue'],
  ]) {
    it(`resolves inferred services through ${name}`, async () => {
      await agent.close({ ritmReset: false })
      Object.assign(process.env, env)
      tracer = await agent.load('aws-lambda', pluginConfig, { experimental: { exporter: 'agent' }, ...coreConfig })
      delete require.cache[require.resolve('../../src/lambda/facade')]
      facade = require('../../src/lambda/facade')
      sinon.stub(tracer._tracer._exporter, 'export').callsFake(trace => traces.push(trace))
      const { spans } = await invoke(event('sqs'), handlerConfig)
      assert.strictEqual(spans.find(span => span.name === 'aws.sqs').service, expected)
    })
  }

  for (const [fixture, count] of [
    ['api-gateway-traced-authorizer-request-v1', 2],
    ['api-gateway-traced-authorizer-request-v1-cached', 1],
    ['api-gateway-traced-authorizer-token-v1', 2],
    ['api-gateway-traced-authorizer-token-v1-cached', 1],
    ['api-gateway-traced-authorizer-request-v2', 1],
    ['api-gateway-traced-authorizer-request-v2-cached', 1],
    ['api-gateway-traced-authorizer-request-websocket-connect', 2],
    ['api-gateway-traced-authorizer-request-websocket-message', 1],
  ]) {
    it(`preserves the real ${fixture} span chain`, async () => {
      const { lambda, spans } = await invoke(event(fixture))
      const inferred = spans.filter(span => span.name.startsWith('aws.api') || span.name === 'aws.httpapi')
      assert.strictEqual(inferred.length, count)
      assert.strictEqual(lambda.parent_id.toString(10), inferred.at(-1).span_id.toString(10))
      if (count === 2) {
        assert.strictEqual(inferred[0].name, 'aws.apigateway.authorizer')
        assert.strictEqual(inferred[1].parent_id.toString(10), inferred[0].span_id.toString(10))
        const first = finished.find(span => span._name === 'aws.apigateway.authorizer')
        const next = finished.find(span => span._name === 'aws.apigateway')
        assert.strictEqual(first._startTime + first._duration, next._startTime)
        assert.ok(first._duration >= 0)
      }
    })
  }

  it('keeps authorizer extraction and inferred decoding under their source flags', async () => {
    const { lambda, spans } = await invoke(event('api-gateway-traced-authorizer-request-v1'), {
      decodeAuthorizerContext: false, encodeAuthorizerContext: true,
    })
    const authorizer = spans.find(span => span.name === 'aws.apigateway.authorizer')
    assert.ok(authorizer)
    assert.strictEqual(authorizer.parent_id.toString(10), '0')
    assert.notStrictEqual(lambda.trace_id.toString(10), '4110911582297405551')
    traces.length = 0
    const second = await invoke(event('api-gateway-traced-authorizer-request-v1'), {
      decodeAuthorizerContext: true, encodeAuthorizerContext: false,
    })
    assert.strictEqual(second.spans.some(span => span.name === 'aws.apigateway.authorizer'), false)
  })

  for (const [name, input] of [
    ['request authorizer', { requestContext: { requestId: 'authorizing-request' } }],
    ['token authorizer', {}],
    ['authorizer with inferred HTTP span', event('api-gateway-v1')],
    ['authorizer with inferred async span', event('sqs')],
  ]) {
    it(`encodes the selected span and nanosecond finish time for ${name}`, async () => {
      const response = { principalId: 'user', policyDocument: {}, context: { preserved: 'value' } }
      const { result, spans } = await invoke(input, { traceExtractor: () => parent }, () => response)
      assert.strictEqual(result, response)
      assert.strictEqual(result.context.preserved, 'value')
      const headers = decode(result.context._datadog)
      const inferred = spans.find(span => span.name === 'aws.apigateway' || span.name === 'aws.sqs')
      const selected = inferred || assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(headers['x-datadog-trace-id'], selected.trace_id.toString(10))
      assert.strictEqual(headers['x-datadog-parent-id'], selected.span_id.toString(10))
      assert.strictEqual(headers['x-datadog-sampling-priority'], '2')
      assert.strictEqual(headers[requestHeader], input.requestContext?.requestId)
      const native = finished.find(span => span.context().toSpanId() === selected.span_id.toString(10))
      assert.strictEqual(headers[finishHeader], (native._startTime + native._duration) * 1e6)
    })
  }

  it('does not encode ordinary responses or disabled authorizers', async () => {
    for (const [response, config] of [
      [{ statusCode: 200 }, {}],
      [{ principalId: 'user' }, {}],
      [{ policyDocument: {} }, {}],
      [{ principalId: 'user', policyDocument: {} }, { encodeAuthorizerContext: false }],
    ]) {
      traces.length = 0
      const { result } = await invoke({}, config, () => response)
      assert.deepStrictEqual(result, response)
      assert.strictEqual(result.context, undefined)
    }
  })

  it('keeps the existing timeout flush idempotent with an inferred parent and unfinished child', async () => {
    const wrapped = facade.wrap(() => {
      tracer.startSpan('unfinished', { childOf: tracer.scope().active() })
      clock.tick(30_000)
      return 'after timeout'
    })
    assert.strictEqual(await wrapped(event('api-gateway-v1'), { ...invocationContext }), 'after timeout')
    assertExactlyOneLambdaSpan(traces)
    for (const name of ['aws.apigateway', 'aws.lambda', 'unfinished']) {
      assert.strictEqual(traces.flat().filter(span => span.name === name).length, 1)
    }
    const lambda = traces.flat().find(span => span.name === 'aws.lambda')
    assert.strictEqual(lambda.meta['error.type'], 'Impending Timeout')
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('contains authorizer encoding failure without changing the customer result', async () => {
    sinon.stub(tracer._tracer, 'inject').throws(Error('injection failed'))
    const response = { principalId: 'user', policyDocument: {} }
    const { result } = await invoke({}, {}, () => response)
    assert.strictEqual(result, response)
    assert.strictEqual(result.context._datadog, undefined)
  })
})
