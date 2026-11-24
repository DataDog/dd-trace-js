'use strict'

/* eslint-disable no-console -- Exercise the customer console API through the real Lambda lifecycle. */

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { VERSION } = require('../../../../version')
const { HANDLER_STREAMING, STREAM_RESPONSE } = require('../../../datadog-instrumentations/src/helpers/lambda-handler')
const agent = require('../plugins/agent')
const { assertExactlyOneLambdaSpan } = require('./helpers')

const shimVersion = 'test-shim'
const fixtures = '../../../datadog-plugin-aws-lambda/test/fixtures/'
const durableArn = 'arn:aws:lambda:us-east-1:123456789012:function:my-func:1/' +
  'durable-execution/my-execution/execution-id'
const defaultContext = {
  functionName: 'MixedCase-Function',
  invokedFunctionArn: 'arn:aws:lambda:US-EAST-1:123456789012:function:MixedCase-Function:PROD',
  awsRequestId: 'request-id',
  getRemainingTimeInMillis: () => 30_000,
}

function fixture (name) {
  return structuredClone(require(fixtures + name + '.json'))
}

describe('Lambda invocation metadata', () => {
  const oldEnv = process.env
  let tracer, facade, traces, clock

  beforeEach(async () => {
    process.env = { ...oldEnv, AWS_LAMBDA_FUNCTION_NAME: defaultContext.functionName, DD_TRACE_ENABLED: 'true' }
    for (const key of ['_X_AMZN_TRACE_ID', 'DD_SERVICE', 'DD_SERVICE_MAPPING', 'DD_CAPTURE_LAMBDA_PAYLOAD',
      'DD_CAPTURE_LAMBDA_PAYLOAD_MAX_DEPTH', 'DD_LOGS_INJECTION', 'DD_TRACE_MANAGED_SERVICES']) delete process.env[key]
    tracer = await agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' } })
    delete require.cache[require.resolve('../../src/lambda/facade')]
    facade = require('../../src/lambda/facade')
    traces = []
    sinon.stub(tracer._tracer._exporter, 'export').callsFake(trace => traces.push(trace))
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(async () => {
    clock.restore()
    await agent.close({ ritmReset: false })
    sinon.restore()
    process.env = oldEnv
  })

  async function invoke (input = {}, config = {}, result = { statusCode: 200 }, context = defaultContext) {
    const handler = async () => result
    const wrapped = facade.wrap(handler, { injectLogContext: false, datadogLambdaVersion: shimVersion, ...config })
    assert.strictEqual(await wrapped(input, { ...context }), result)
    assert.strictEqual(clock.countTimers(), 0)
    return assertExactlyOneLambdaSpan(traces)
  }

  it('applies source function, qualifier, request and version tags', async () => {
    const span = await invoke()
    assert.strictEqual(span.meta['span.kind'], 'server')
    assert.strictEqual(span.meta.function_arn, 'arn:aws:lambda:us-east-1:123456789012:function:mixedcase-function')
    assert.strictEqual(span.meta.function_version, 'prod')
    assert.strictEqual(span.meta.functionname, 'mixedcase-function')
    assert.strictEqual(span.meta.resource_names, 'MixedCase-Function')
    assert.strictEqual(span.meta.request_id, 'request-id')
    assert.strictEqual(span.meta.dd_trace, VERSION)
    assert.strictEqual(span.meta.datadog_lambda, shimVersion)
    assert.strictEqual(span.meta.cold_start, undefined)
    assert.strictEqual(span.meta.proactive_initialization, undefined)
  })

  for (const [suffix, expected] of [['', '$LATEST'], [':7', '7'], [':$LATEST', '$latest'], [':ALIAS', 'alias']]) {
    it(`preserves the source qualifier behavior for ${suffix || 'unqualified'}`, async () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:function:Fn'
      const span = await invoke({}, {}, {}, { ...defaultContext, invokedFunctionArn: arn + suffix })
      assert.strictEqual(span.meta.function_arn, arn.toLowerCase())
      assert.strictEqual(span.meta.function_version, expected)
    })
  }

  for (const [name, source] of [
    ['api-gateway-v1', 'api-gateway'], ['api-gateway-v2', 'api-gateway'],
    ['api-gateway-wss', 'api-gateway'], ['lambda-function-urls', 'lambda-function-url'],
    ['application-load-balancer', 'application-load-balancer'], ['sns', 'sns'], ['sqs', 'sqs'],
    ['snssqs', 'sqs'], ['eventbridge-sqs', 'sqs'], ['eventbridge', 'eventbridge'],
    ['kinesis', 'kinesis'], ['dynamodb', 'dynamodb'], ['s3', 's3'],
  ]) {
    it(`wires the ${name} source tags onto the invocation`, async () => {
      const span = await invoke(fixture(name))
      assert.strictEqual(span.meta['function_trigger.event_source'], source)
      if (name === 'lambda-function-urls') assert.strictEqual(span.meta['function_trigger.event_source_arn'], undefined)
      else assert.ok(span.meta['function_trigger.event_source_arn'])
    })
  }

  it('applies HTTP request tags from the source fixture without changing the event', async () => {
    const input = fixture('api-gateway-v1')
    const copy = structuredClone(input)
    const span = await invoke(input)
    assert.strictEqual(span.meta['http.method'], 'GET')
    assert.strictEqual(span.meta['http.url'], 'https://id.execute-api.us-east-1.amazonaws.com/my/path')
    assert.strictEqual(span.meta['http.route'], '/my/path')
    assert.strictEqual(span.meta['http.status_code'], '200')
    assert.deepStrictEqual(input, copy)
  })

  for (const statusCode of [200, 404, 500, '503', '5000', '50', 0, '']) {
    for (const createInferredSpan of [false, true]) {
      it(`preserves HTTP status ${JSON.stringify(statusCode)} with inferred=${createInferredSpan}`, async () => {
        const span = await invoke(fixture('api-gateway-v1'), { createInferredSpan }, { statusCode })
        const expected = statusCode ? String(statusCode) : '200'
        assert.strictEqual(span.meta['http.status_code'], expected)
        assert.strictEqual(span.error, createInferredSpan && expected.length === 3 && expected.startsWith('5') ? 1 : 0)
        const inferred = traces.flat().find(span => span.name === 'aws.apigateway')
        if (createInferredSpan) {
          assert.strictEqual(inferred.meta['http.status_code'], expected)
          assert.strictEqual(inferred.error, 0)
        } else assert.strictEqual(inferred, undefined)
      })
    }
  }

  for (const streaming of [false, true]) {
    it(`uses the source missing-response status for streaming=${streaming}`, async () => {
      const handler = async () => undefined
      if (streaming) handler[HANDLER_STREAMING] = STREAM_RESPONSE
      const wrapped = facade.wrap(handler, { injectLogContext: false })
      const pending = streaming
        ? wrapped(fixture('api-gateway-v1'), {}, { ...defaultContext })
        : wrapped(fixture('api-gateway-v1'), { ...defaultContext })
      assert.strictEqual(await pending, undefined)
      const span = assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(span.meta['http.status_code'], streaming ? '200' : '502')
      assert.strictEqual(span.error, streaming ? 0 : 1)
    })
  }

  it('does not apply HTTP status to a non-HTTP trigger', async () => {
    const span = await invoke(fixture('sqs'), {}, { statusCode: 500 })
    assert.strictEqual(span.meta['http.status_code'], undefined)
    assert.strictEqual(span.error, 0)
    assert.strictEqual(traces.flat().find(span => span.name === 'aws.sqs').meta['http.status_code'], undefined)
  })

  for (const enabled of [false, true]) {
    it(`honors payload capture=${enabled} without mutating either payload`, async () => {
      const input = { headers: { authorization: 'secret', Authorization: 'source-case-sensitive' }, body: '{"n":1}' }
      const result = { password: 'secret', token: 'secret', value: false, list: [1, null] }
      const original = structuredClone({ input, result })
      const span = await invoke(input, { captureLambdaPayload: enabled }, result)
      assert.deepStrictEqual({ input, result }, original)
      if (enabled) {
        assert.strictEqual(span.meta['function.request.headers.authorization'], 'redacted')
        assert.strictEqual(span.meta['function.request.headers.Authorization'], 'source-case-sensitive')
        assert.strictEqual(span.meta['function.request.body.n'], '1')
        assert.strictEqual(span.meta['function.response.password'], 'redacted')
        assert.strictEqual(span.meta['function.response.token'], 'redacted')
        assert.strictEqual(span.meta['function.response.value'], 'false')
        assert.strictEqual(span.meta['function.response.list.0'], '1')
      } else assert.strictEqual(Object.keys(span.meta).some(key => key.startsWith('function.request')), false)
    })
  }

  for (const depth of [0, 1, 2]) {
    it(`preserves payload depth ${depth} including JSON-string boundaries`, async () => {
      const input = { body: '{"nested":{"value":"data"}}' }
      const span = await invoke(input, { captureLambdaPayload: true, captureLambdaPayloadMaxDepth: depth }, {})
      const expected = depth === 0
        ? JSON.stringify(input)
        : depth === 1 ? JSON.stringify(input.body) : '{"nested":{"value":"data"}}'
      assert.strictEqual(span.meta[depth === 0 ? 'function.request' : 'function.request.body'], expected)
    })
  }

  it('captures request payload on a throw while preserving the original error', async () => {
    const failure = Error('customer failure')
    const wrapped = facade.wrap(() => { throw failure }, { captureLambdaPayload: true, injectLogContext: false })
    await assert.rejects(wrapped({ key: 'value' }, { ...defaultContext }), error => error === failure)
    const span = assertExactlyOneLambdaSpan(traces)
    assert.strictEqual(span.meta['function.request.key'], 'value')
    assert.strictEqual(Object.keys(span.meta).some(key => key.startsWith('function.response')), false)
    assert.strictEqual(span.meta['error.message'], failure.message)
  })

  for (const operationCount of [0, 1, 2]) {
    it(`applies Durable context and status for ${operationCount} operations`, async () => {
      const span = await invoke({
        DurableExecutionArn: durableArn,
        InitialExecutionState: { Operations: Array.from({ length: operationCount }, () => ({})) },
      }, {},
      { Status: 'SUCCEEDED' })
      assert.strictEqual(span.meta['aws.durable.execution_name'], 'my-execution')
      assert.strictEqual(span.meta['aws.durable.execution_id'], 'execution-id')
      assert.strictEqual(span.meta['aws.durable.first_invocation'], String(operationCount === 1))
      assert.strictEqual(span.meta['aws.durable.execution_status'], 'SUCCEEDED')
    })
  }

  it('rejects unsupported Durable status and requires the event ARN', async () => {
    for (const [input, result] of [[{}, { Status: 'FAILED' }],
      [{ DurableExecutionArn: durableArn }, { Status: 'UNKNOWN' }]]) {
      traces.length = 0
      const span = await invoke(input, {}, result)
      assert.strictEqual(span.meta['aws.durable.execution_status'], undefined)
    }
  })

  it('retains the source HTTP 5xx early return before Durable tagging', async () => {
    const input = { ...fixture('api-gateway-v1'), DurableExecutionArn: durableArn }
    const span = await invoke(input, {}, { statusCode: 500, Status: 'FAILED' })
    assert.strictEqual(span.error, 1)
    assert.strictEqual(span.meta['aws.durable.execution_name'], undefined)
    assert.strictEqual(span.meta['aws.durable.execution_status'], undefined)
  })

  it('applies extraction first-use Step Functions context and resets it on warm reuse', async () => {
    const wrapped = facade.wrap(async () => 'ok', { injectLogContext: false })
    const input = fixture('legacy-step-function-event')
    await wrapped(input, { ...defaultContext })
    const first = assertExactlyOneLambdaSpan(traces)
    assert.strictEqual(first.meta.execution_id, input.Execution.Id)
    assert.strictEqual(first.meta.state_name, input.State.Name)
    assert.strictEqual(first.meta.state_entered_time, input.State.EnteredTime)
    assert.strictEqual(first.meta.retry_count, String(input.State.RetryCount ?? '0'))
    traces.length = 0
    await wrapped({}, { ...defaultContext, awsRequestId: 'second-request' })
    const second = assertExactlyOneLambdaSpan(traces)
    assert.strictEqual(second.meta.execution_id, undefined)
    assert.strictEqual(second.meta.request_id, 'second-request')
    assert.strictEqual(second.meta['http.status_code'], undefined)
    assert.strictEqual(second.error, 0)
  })

  it('does not independently parse Step Functions metadata after successful custom extraction', async () => {
    const span = await invoke(fixture('legacy-step-function-event'), {
      traceExtractor: () => ({
        traceId: '1234', parentId: '5678', sampleMode: 2, source: 'event',
      }),
    })
    assert.strictEqual(span.meta.execution_id, undefined)
    assert.strictEqual(span.parent_id.toString(10), '5678')
  })

  it('uses the outer Step Functions envelope when HTTP extraction found no parent', async () => {
    const input = { ...fixture('legacy-step-function-event'), headers: {} }
    const span = await invoke(input)
    assert.strictEqual(span.meta.execution_id, input.Execution.Id)
  })

  it('retains an earlier invalid message-carrier Step Functions first use', async () => {
    const input = {
      ...fixture('legacy-step-function-event'),
      Records: [{
        eventSource: 'aws:sqs',
        body: '',
        attributes: { SentTimestamp: '1' },
        messageAttributes: { _datadog: { stringValue: '{}' } },
      }],
    }
    const span = await invoke(input)
    assert.strictEqual(span.meta.execution_id, undefined)
  })

  it('sets response metadata before either invocation or inferred span finishes', async () => {
    const channel = dc.channel('dd-trace:span:finish')
    const observed = []
    const capture = span => {
      if (span._name === 'aws.lambda' || span._name === 'aws.apigateway') {
        observed.push([span._name, span.context().getTag('http.status_code')])
      }
    }
    channel.subscribe(capture)
    try {
      await invoke(fixture('api-gateway-v1'), {}, { statusCode: 503 })
      assert.deepStrictEqual(observed, [['aws.lambda', '503'], ['aws.apigateway', '503']])
    } finally {
      channel.unsubscribe(capture)
    }
  })

  for (const injectLogContext of [false, true]) {
    it(`correlates console output only with injectLogContext=${injectLogContext}`, async () => {
      const sink = sinon.stub(console, 'log')
      let rootContext, childContext
      const input = { message: 'structured', dd: { env: 'existing' } }
      const wrapped = facade.wrap(() => {
        rootContext = tracer.scope().active().context()
        console.log(input)
        tracer.trace('child', () => {
          childContext = tracer.scope().active().context()
          console.log('child %s', 'message')
        })
        return 'ok'
      }, { injectLogContext })
      assert.strictEqual(await wrapped({}, { ...defaultContext }), 'ok')
      if (injectLogContext) {
        assert.deepStrictEqual(sink.firstCall.args, [{
          message: 'structured',
          dd: {
            env: 'existing', trace_id: rootContext.toTraceId(), span_id: rootContext.toSpanId(),
          },
        }])
        assert.deepStrictEqual(sink.secondCall.args, [
          `[dd.trace_id=${childContext.toTraceId()} dd.span_id=${childContext.toSpanId()}] child %s`, 'message',
        ])
      } else {
        assert.strictEqual(sink.firstCall.args[0], input)
        assert.deepStrictEqual(sink.secondCall.args, ['child %s', 'message'])
      }
      assert.deepStrictEqual(input, { message: 'structured', dd: { env: 'existing' } })
      console.log('outside')
      assert.deepStrictEqual(sink.lastCall.args, ['outside'])
      assertExactlyOneLambdaSpan(traces)
    })
  }

  it('keeps disabled and completed invocations out of an already-installed console patch', async () => {
    const sink = sinon.stub(console, 'log')
    const enabled = facade.wrap(() => { console.log('enabled'); return 'ok' }, { injectLogContext: true })
    const disabled = facade.wrap(() => { console.log('disabled'); return 'ok' }, { injectLogContext: false })
    await enabled({}, { ...defaultContext })
    assert.match(sink.lastCall.args[0], /^\[dd.trace_id=\d+ dd.span_id=\d+\] enabled$/)
    traces.length = 0
    await disabled({}, { ...defaultContext })
    assert.deepStrictEqual(sink.lastCall.args, ['disabled'])
    console.log('outside')
    assert.deepStrictEqual(sink.lastCall.args, ['outside'])
    assertExactlyOneLambdaSpan(traces)
  })

  it('preserves error outcomes and stops console correlation after a failing handler', async () => {
    const sink = sinon.stub(console, 'log')
    const failure = Error('failure')
    const wrapped = facade.wrap(() => { console.log('during'); throw failure }, { injectLogContext: true })
    await assert.rejects(wrapped({}, { ...defaultContext }), error => error === failure)
    assert.match(sink.firstCall.args[0], /^\[dd.trace_id=\d+ dd.span_id=\d+\] during$/)
    console.log('after')
    assert.deepStrictEqual(sink.lastCall.args, ['after'])
    assertExactlyOneLambdaSpan(traces)
  })

  it('contains a payload formatting failure and still returns the customer result', async () => {
    const input = { value: 1n }
    const result = { statusCode: 200 }
    const span = await invoke(input, { captureLambdaPayload: true, captureLambdaPayloadMaxDepth: 0 }, result)
    assert.strictEqual(span.error, 0)
    assert.strictEqual(span.meta['function.request'], undefined)
  })
  it('restores console methods when the plugin is disabled', async () => {
    const sink = sinon.stub(console, 'log')
    const enabled = facade.wrap(() => { console.log('enabled'); return 'ok' }, { injectLogContext: true })
    await enabled({}, { ...defaultContext })
    assert.notStrictEqual(console.log, sink)
    tracer.use('aws-lambda', false)
    assert.strictEqual(console.log, sink)
    traces.length = 0
    const disabled = facade.wrap(async () => { console.log('disabled'); return 'ok' })
    assert.strictEqual(await disabled({}, { ...defaultContext }), 'ok')
    assert.deepStrictEqual(sink.lastCall.args, ['disabled'])
    assert.strictEqual(traces.flat().length, 0)
    assert.strictEqual(clock.countTimers(), 0)
  })
})
