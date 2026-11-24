'use strict'

const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { HANDLER_STREAMING, STREAM_RESPONSE } = require('../../../datadog-instrumentations/src/helpers/lambda-handler')
const agent = require('../plugins/agent')
const { assertExactlyOneLambdaSpan } = require('./helpers')

const awsTraceId = '1-5e272390-8c398be037738dc042009320'
const awsParentId = '94ae789b969f1cc5'
const awsHeader = `Root=${awsTraceId};Parent=${awsParentId};Sampled=1`
const headers = { 'x-datadog-trace-id': '1234', 'x-datadog-parent-id': '5678', 'x-datadog-sampling-priority': '2' }
const customParent = { traceId: '1234', parentId: '5678', sampleMode: 2, source: 'event' }
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64')
const sqs = carrier => ({
  eventSource: 'aws:sqs',
  messageAttributes: { _datadog: { stringValue: JSON.stringify(carrier) } },
})
const sns = carrier => ({ Type: 'String', Value: JSON.stringify(carrier) })
const msk = carrier => ({
  headers: Object.entries(carrier).map(([key, value]) => ({ [key]: [...Buffer.from(value)] })),
})
const context = {
  functionName: 'xray-test',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:xray-test',
  awsRequestId: 'request',
  getRemainingTimeInMillis: () => 30_000,
}

function fixture (name) {
  return structuredClone(require('../../../datadog-plugin-aws-lambda/test/fixtures/' + name + '.json'))
}

function httpEvent () {
  return { ...fixture('api-gateway-v1'), headers }
}

const stepEvent = fixture('legacy-step-function-event')
const stepTrigger = {
  'function_trigger.event_source': 'states',
  'function_trigger.event_source_arn': stepEvent.StateMachine.Id,
}
const stepMetadata = {
  execution_id: stepEvent.Execution.Id,
  redrive_count: '0',
  retry_count: '2',
  state_entered_time: '2022-12-08T21:08:19.224Z',
  state_name: 'step-one',
}

describe('Lambda X-Ray metadata lifecycle', () => {
  const oldEnv = process.env
  const finishChannel = dc.channel('dd-trace:span:finish')
  let tracer, facade, traces, clock, messages, sockets, order, createSocket
  const onFinish = span => {
    if (span._name === 'aws.lambda' || span._name === 'aws.apigateway') order.push(span._name + ':finish')
  }

  beforeEach(async () => {
    process.env = {
      ...oldEnv,
      AWS_LAMBDA_FUNCTION_NAME: context.functionName,
      DD_TRACE_ENABLED: 'true',
      _X_AMZN_TRACE_ID: awsHeader,
      AWS_XRAY_DAEMON_ADDRESS: '127.0.0.1:2000',
    }
    delete process.env.DD_MERGE_XRAY_TRACES
    tracer = await agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' } })
    delete require.cache[require.resolve('../../src/lambda/facade')]
    facade = require('../../src/lambda/facade')
    traces = []; messages = []; sockets = []; order = []
    sinon.stub(tracer._tracer._exporter, 'export').callsFake(trace => traces.push(trace))
    createSocket = sinon.stub(dgram, 'createSocket').callsFake(() => {
      const socket = new EventEmitter()
      socket.send = sinon.spy((buffer, start, length, port, address, callback) => {
        assert.strictEqual(port, 2000)
        assert.strictEqual(address, '127.0.0.1')
        assert.strictEqual(start, 0)
        assert.strictEqual(length, buffer.length)
        const [frame, json] = buffer.toString().split('\n')
        assert.strictEqual(frame, '{"format": "json", "version": 1}')
        const segment = JSON.parse(json)
        assert.match(segment.id, /^[0-9a-f]{16}$/)
        assert.strictEqual(segment.trace_id, awsTraceId)
        assert.strictEqual(segment.parent_id, awsParentId)
        assert.strictEqual(segment.name, 'datadog-metadata')
        assert.strictEqual(segment.type, 'subsegment')
        assert.strictEqual(segment.start_time, segment.end_time)
        messages.push(segment.metadata.datadog)
        order.push(Object.keys(segment.metadata.datadog)[0])
        callback(null, buffer.length)
      })
      socket.close = sinon.spy()
      sockets.push(socket)
      return socket
    })
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    finishChannel.subscribe(onFinish)
  })

  afterEach(async () => {
    finishChannel.unsubscribe(onFinish)
    clock.restore()
    await agent.close({ ritmReset: false })
    sinon.restore()
    process.env = oldEnv
  })

  async function invoke (event, config = {}, result = { statusCode: 200 }, lambdaContext = context) {
    const wrapped = facade.wrap(() => result, { injectLogContext: false, ...config })
    assert.strictEqual(await wrapped(event, { ...lambdaContext }), result)
    const span = assertExactlyOneLambdaSpan(traces)
    assert.strictEqual(clock.countTimers(), 0)
    for (const socket of sockets) assert.strictEqual(socket.close.callCount, 1)
    return span
  }

  for (const source of ['event', 'xray', 'ddtrace']) {
    for (const merge of [false, true]) {
      for (const asynchronous of [false, true]) {
        it(`sends custom ${source} metadata independently of merge=${merge}, async=${asynchronous}`, async () => {
          const parent = { ...customParent, source }
          const traceExtractor = asynchronous ? async () => parent : () => parent
          const span = await invoke(httpEvent(), { traceExtractor, mergeXrayTraces: merge })
          assert.deepStrictEqual(messages[0], {
            trace: { 'trace-id': '1234', 'parent-id': '5678', 'sampling-priority': 2 },
          })
          assert.strictEqual(messages[1].lambda_function_tags['http.status_code'], '200')
          assert.strictEqual(span.trace_id.toString(10) === '1234', source === 'event' || merge)
          assert.deepStrictEqual(order, ['trace', 'aws.lambda:finish', 'lambda_function_tags', 'aws.apigateway:finish'])
        })
      }
    }
  }

  for (const priority of [-1, 0, 1, 2]) {
    it(`retains numeric extracted sampling priority ${priority} in the trace payload`, async () => {
      await invoke({}, { traceExtractor: () => ({ ...customParent, sampleMode: priority }) })
      assert.deepStrictEqual(messages, [{
        trace: { 'trace-id': '1234', 'parent-id': '5678', 'sampling-priority': priority },
      }, { lambda_function_tags: {} }])
    })
  }

  for (const [name, event] of [
    ['HTTP', { headers }],
    ['SNS', { Records: [{ Sns: { MessageAttributes: { _datadog: sns(headers) } } }] }],
    ['SNS-SQS', {
      Records: [{
        ...sqs({}),
        body: JSON.stringify({
          Type: 'Notification', TopicArn: 'topic', MessageAttributes: { _datadog: sns(headers) },
        }),
      }],
    }],
    ['SQS', { Records: [sqs(headers)] }],
    ['EventBridge-SQS', {
      Records: [{
        ...sqs({}),
        body: JSON.stringify({
          'detail-type': 'test', detail: { _datadog: headers },
        }),
      }],
    }],
    ['EventBridge', { 'detail-type': 'test', detail: { _datadog: headers } }],
    ['AppSync', { info: { selectionSetGraphQL: '{}' }, request: { headers } }],
    ['Kinesis', { Records: [{ kinesis: { data: encode({ _datadog: headers }) } }] }],
    ['MSK', { eventSource: 'aws:kafka', records: { topic: [msk(headers)] } }],
    ['Durable', {
      DurableExecutionArn: 'arn',
      InitialExecutionState: {
        Operations: [{ Name: '_datadog_1', Payload: JSON.stringify(headers) }],
      },
    }],
  ]) {
    it(`sends extracted ${name} context exactly once without requiring an inferred span`, async () => {
      const span = await invoke(structuredClone(event), { createInferredSpan: false, mergeXrayTraces: false })
      assert.deepStrictEqual(messages[0], {
        trace: { 'trace-id': '1234', 'parent-id': '5678', 'sampling-priority': 2 },
      })
      assert.strictEqual(messages.filter(message => message.trace).length, 1)
      assert.strictEqual(span.parent_id.toString(10), '5678')
    })
  }

  it('sends Lambda client-context metadata after unsuccessful event and Step Functions extraction', async () => {
    await invoke({}, {}, {}, { ...context, clientContext: { custom: headers } })
    assert.deepStrictEqual(messages, [{
      trace: { 'trace-id': '1234', 'parent-id': '5678', 'sampling-priority': 2 },
    }, { lambda_function_tags: {} }])
  })

  it('uses the source AUTO_KEEP default when extracted propagation omitted a sampling decision', async () => {
    const { 'x-datadog-sampling-priority': omitted, ...carrier } = headers
    await invoke({ headers: carrier })
    assert.strictEqual(messages[0].trace['sampling-priority'], 1)
  })

  for (const [name, extra] of [
    ['legacy-step-function-event', {}],
    ['nested-step-function-event', {
      root_execution_id: fixture('nested-step-function-event')._datadog.RootExecutionId, serverless_version: 'v1',
    }],
    ['lambda-root-step-function-event', {
      trace_id: '10593586103637578129', dd_p_tid: '6734e7c300000000', serverless_version: 'v1',
    }],
    ['legacy-lambda-root-step-function-event', {
      trace_id: '10593586103637578129', dd_p_tid: '6734e7c300000000', serverless_version: 'legacy-lambda-root',
    }],
  ]) {
    for (const mergeXrayTraces of [false, true]) {
      it(`sends ${name} root metadata with merge=${mergeXrayTraces}`, async () => {
        await invoke(fixture(name), { mergeXrayTraces })
        assert.deepStrictEqual(messages, [
          { root_span_metadata: { ...stepMetadata, ...extra } }, { lambda_function_tags: stepTrigger },
        ])
      })
    }
  }

  for (const [name, event] of [
    ['SNS', { Records: [{ Sns: { MessageAttributes: { _datadog: sns(stepEvent) } } }] }],
    ['SQS', { Records: [sqs(stepEvent)] }],
    ['SNS-SQS', {
      Records: [{
        ...sqs({}),
        body: JSON.stringify({
          Type: 'Notification', TopicArn: 'topic', MessageAttributes: { _datadog: sns(stepEvent) },
        }),
      }],
    }],
    ['EventBridge', { 'detail-type': 'test', detail: { _datadog: stepEvent } }],
    ['EventBridge-SQS', {
      Records: [{
        ...sqs({}),
        body: JSON.stringify({
          'detail-type': 'test', detail: { _datadog: stepEvent },
        }),
      }],
    }],
  ]) {
    it(`uses trace metadata for Step Functions context extracted inside ${name}`, async () => {
      await invoke(structuredClone(event), { createInferredSpan: false })
      assert.deepStrictEqual(messages[0], {
        trace: { 'trace-id': '1139193989631387307', 'parent-id': '7747304477664363642', 'sampling-priority': '1' },
      })
      assert.strictEqual(messages.some(message => message.root_span_metadata), false)
    })
  }

  it('does not replace successful custom metadata with reparsed outer Step Functions data', async () => {
    await invoke(stepEvent, { traceExtractor: () => customParent })
    assert.deepStrictEqual(messages, [{
      trace: { 'trace-id': '1234', 'parent-id': '5678', 'sampling-priority': 2 },
    }, { lambda_function_tags: stepTrigger }])
  })

  for (const asynchronous of [false, true]) {
    it(`falls back to Step Functions metadata after ${asynchronous ? 'async' : 'sync'} extractor error`, async () => {
      const failure = () => { throw Error('extractor failed') }
      await invoke(stepEvent, { traceExtractor: asynchronous ? async () => failure() : failure })
      assert.deepStrictEqual(messages, [{ root_span_metadata: stepMetadata }, { lambda_function_tags: stepTrigger }])
    })
  }

  it('retains an earlier invalid message carrier instead of reparsing outer Step Functions data', async () => {
    await invoke({ ...stepEvent, Records: [sqs({})] }, { createInferredSpan: false })
    assert.strictEqual(messages.some(message => message.root_span_metadata || message.trace), false)
  })

  it('uses the outer Step Functions fallback after unsuccessful HTTP extraction', async () => {
    await invoke({ ...stepEvent, headers: {} })
    assert.deepStrictEqual(messages, [{ root_span_metadata: stepMetadata }, { lambda_function_tags: stepTrigger }])
  })

  for (const mergeXrayTraces of [false, true]) {
    it(`does not echo native X-Ray fallback as extracted metadata with merge=${mergeXrayTraces}`, async () => {
      await invoke({ ...httpEvent(), headers: {} }, { mergeXrayTraces })
      assert.strictEqual(messages.length, 1)
      assert.ok(messages[0].lambda_function_tags)
    })
  }

  for (const value of [undefined, '', 'Root=broken', awsHeader.replace('Sampled=1', 'Sampled=0')]) {
    it(`keeps extracted parenting but sends no metadata for AWS header ${value}`, async () => {
      if (value === undefined) delete process.env._X_AMZN_TRACE_ID
      else process.env._X_AMZN_TRACE_ID = value
      const span = await invoke(httpEvent(), { createInferredSpan: false })
      assert.strictEqual(span.parent_id.toString(10), '5678')
      assert.strictEqual(createSocket.callCount, 0)
    })
  }

  it('sends the source empty trigger document for an unclassified invocation', async () => {
    await invoke({})
    assert.deepStrictEqual(messages, [{ lambda_function_tags: {} }])
  })

  for (const [name, handler, result, status, streaming] of [
    ['sync', () => ({ statusCode: 201 }), { statusCode: 201 }, '201', false],
    ['promise', async () => ({ statusCode: 503 }), { statusCode: 503 }, '503', false],
    ['callback', (event, ctx, callback) => callback(null, { statusCode: 204 }), { statusCode: 204 }, '204', false],
    ['throw', () => { throw Error('handler failed') }, undefined, '502', false],
    ['reject', async () => { throw Error('handler failed') }, undefined, '502', false],
    ['streaming', async () => undefined, undefined, '200', true],
  ]) {
    it(`sends final trigger tags for ${name} completion after the invocation finishes`, async () => {
      const wrappedHandler = () => handler()
      if (streaming) wrappedHandler[HANDLER_STREAMING] = STREAM_RESPONSE
      const wrapped = facade.wrap(name === 'callback' ? handler : wrappedHandler, { injectLogContext: false })
      const pending = streaming ? wrapped(httpEvent(), {}, { ...context }) : wrapped(httpEvent(), { ...context })
      if (name === 'throw' || name === 'reject') await assert.rejects(pending, { message: 'handler failed' })
      else assert.deepStrictEqual(await pending, result)
      assert.strictEqual(messages[1].lambda_function_tags['http.status_code'], status)
      assert.deepStrictEqual(order, ['trace', 'aws.lambda:finish', 'lambda_function_tags', 'aws.apigateway:finish'])
      assertExactlyOneLambdaSpan(traces)
    })
  }

  it('does not carry Step Functions metadata or previous trigger status into a warm invocation', async () => {
    const wrapped = facade.wrap(async () => ({}), { injectLogContext: false })
    await wrapped(stepEvent, { ...context })
    assert.deepStrictEqual(messages, [{ root_span_metadata: stepMetadata }, { lambda_function_tags: stepTrigger }])
    messages.length = 0; traces.length = 0
    await wrapped(httpEvent(), { ...context, awsRequestId: 'second' })
    assert.deepStrictEqual(messages[0], {
      trace: { 'trace-id': '1234', 'parent-id': '5678', 'sampling-priority': 2 },
    })
    assert.strictEqual(messages.length, 2)
    assert.strictEqual(messages[1].lambda_function_tags['http.status_code'], '200')
    assertExactlyOneLambdaSpan(traces)
  })

  for (const throws of [false, true]) {
    it(`keeps the handler ${throws ? 'error' : 'result'} when X-Ray transport fails`, async () => {
      createSocket.throws(Error('socket failed'))
      const failure = Error('customer failure')
      const result = { statusCode: 200 }
      const wrapped = facade.wrap(() => {
        if (throws) throw failure
        return result
      }, { injectLogContext: false })
      const pending = wrapped(httpEvent(), { ...context })
      if (throws) await assert.rejects(pending, error => error === failure)
      else assert.strictEqual(await pending, result)
      assert.strictEqual(createSocket.callCount, 2)
      assertExactlyOneLambdaSpan(traces)
    })
  }

  it('does not send metadata when the Lambda plugin is disabled', async () => {
    tracer.use('aws-lambda', false)
    const wrapped = facade.wrap(async () => 'done')
    assert.strictEqual(await wrapped(httpEvent(), { ...context }), 'done')
    assert.strictEqual(createSocket.callCount, 0)
    assert.strictEqual(traces.flat().length, 0)
  })
})
