'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const TraceContextExtractor = require('../../src/context/extractor')
const { fromTraceContext } = require('../../src/context/span-context')
const { extractHTTP, getInjectedAuthorizerHeaders } = require('../../src/context/http')
const { extractMSK, extractDurableExecution } = require('../../src/context/events')

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64')
const headers = {
  'x-datadog-trace-id': '4110911582297405551',
  'x-datadog-parent-id': '797643193680388251',
  'x-datadog-sampling-priority': '2',
}
const customContext = {
  traceId: headers['x-datadog-trace-id'],
  parentId: headers['x-datadog-parent-id'],
  sampleMode: 2,
  source: 'event',
}
const snsAttribute = { Type: 'String', Value: JSON.stringify(headers) }
const sqsRecord = { eventSource: 'aws:sqs', messageAttributes: { _datadog: { stringValue: JSON.stringify(headers) } } }
const stepEvent = require('../fixtures/legacy-step-function-event.json')
const mskRecord = carrier => ({
  headers: Object.entries(carrier).map(([key, value]) =>
    ({ [key]: Array.from(Buffer.from(value)) })),
})
const mskEvent = records => ({ eventSource: 'aws:kafka', records })
const javaHeader = 'Root=1-663934f8-0000000045c5da17458c9910;Parent=18f37c8f541d052f;Sampled=1'

describe('Lambda context extraction', () => {
  let tracer
  let spanContext
  const oldEnv = process.env

  beforeEach(() => {
    process.env = { ...oldEnv }
    delete process.env._X_AMZN_TRACE_ID
    spanContext = fromTraceContext(customContext)
    tracer = { extract: sinon.stub().returns(spanContext) }
  })

  afterEach(() => { process.env = oldEnv })

  function extract (event, context = {}, config = {}) {
    return new TraceContextExtractor(tracer, config).extract(event, context)
  }

  for (const [name, event] of [
    ['HTTP', { headers }],
    ['HTTP multi-value', { multiValueHeaders: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]])) }],
    ['SNS string', { Records: [{ Sns: { MessageAttributes: { _datadog: snsAttribute } } }] }],
    ['SNS binary', {
      Records: [{
        Sns: {
          MessageAttributes: {
            _datadog: {
              Type: 'Binary', Value: encode(headers),
            },
          },
        },
      }],
    }],
    ['SNS-SQS string', {
      Records: [{
        ...sqsRecord,
        body: JSON.stringify({
          Type: 'Notification',
          TopicArn: 'topic',
          MessageAttributes: { _datadog: snsAttribute },
        }),
      }],
    }],
    ['SNS-SQS binary', {
      Records: [{
        ...sqsRecord,
        body: JSON.stringify({
          Type: 'Notification',
          TopicArn: 'topic',
          MessageAttributes: { _datadog: { Type: 'Binary', Value: encode(headers) } },
        }),
      }],
    }],
    ['SNS-SQS SQS fallback', {
      Records: [{ ...sqsRecord, body: JSON.stringify({ Type: 'Notification', TopicArn: 't' }) }],
    }],
    ['SQS string', { Records: [sqsRecord] }],
    ['SQS binary raw SNS delivery', {
      Records: [{
        eventSource: 'aws:sqs',
        messageAttributes: {
          _datadog: {
            binaryValue: encode(headers),
          },
        },
      }],
    }],
    ['EventBridge-SQS', {
      Records: [{
        ...sqsRecord,
        body: JSON.stringify({
          'detail-type': 'test',
          detail: { _datadog: headers },
        }),
      }],
    }],
    ['AppSync', { info: { selectionSetGraphQL: '{}' }, request: { headers } }],
    ['MSK', mskEvent({ 'topic-0': [mskRecord(headers)] })],
    ['Kinesis', { Records: [{ kinesis: { data: encode({ _datadog: headers }) } }] }],
    ['EventBridge', { 'detail-type': 'test', detail: { _datadog: headers } }],
    ['Durable', {
      DurableExecutionArn: 'arn',
      InitialExecutionState: {
        Operations: [
          { Name: '_datadog_0', StepDetails: { Result: JSON.stringify(headers) } },
        ],
      },
    }],
  ]) {
    it(`extracts the source ${name} carrier through core propagation`, () => {
      const result = extract(structuredClone(event))
      assert.strictEqual(result.spanContext, spanContext)
      assert.strictEqual(result.source, 'event')
      sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', headers)
    })
  }

  for (const [name, carrier] of [['legacy', headers], ['nested', { _datadog: headers }]]) {
    it(`extracts ${name} Lambda client context`, () => {
      assert.strictEqual(extract({}, { clientContext: { custom: carrier } }).spanContext, spanContext)
      sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', headers)
    })
  }

  it('does not use legacy client headers when _datadog is explicitly present', () => {
    tracer.extract.returns(null)
    assert.strictEqual(extract({}, { clientContext: { custom: { ...headers, _datadog: null } } }).spanContext, null)
    sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', null)
  })

  for (const async of [false, true]) {
    for (const legacy of [false, true]) {
      it(`awaits ${async ? 'async' : 'sync'} custom extraction with ${legacy ? 'legacy' : 'current'} IDs`, async () => {
        const value = legacy
          ? {
              traceID: customContext.traceId,
              parentID: customContext.parentId,
              sampleMode: 2,
              source: 'event',
            }
          : customContext
        const custom = sinon.stub().returns(async ? Promise.resolve(value) : value)
        const event = { headers }
        const context = {}
        const result = await extract(event, context, { traceExtractor: custom })
        sinon.assert.calledOnceWithExactly(custom, event, context)
        sinon.assert.notCalled(tracer.extract)
        assert.strictEqual(result.spanContext.toTraceId(), customContext.traceId)
        assert.strictEqual(result.spanContext.toSpanId(), customContext.parentId)
        assert.strictEqual(result.spanContext._sampling.priority, 2)
        assert.strictEqual(result.source, 'event')
      })
    }
  }

  for (const value of [undefined, null, {}, { traceId: '123', sampleMode: 1 }, { parentId: '456', sampleMode: 1 }]) {
    it(`falls back after an invalid custom result: ${JSON.stringify(value)}`, async () => {
      const result = await extract({ headers }, {}, { traceExtractor: () => value })
      assert.strictEqual(result.spanContext, spanContext)
      sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', headers)
    })
  }

  for (const custom of [() => { throw Error('extractor') }, async () => { throw Error('extractor') }]) {
    it('falls back after a throwing or rejecting custom extractor', async () => {
      assert.strictEqual((await extract({ headers }, {}, { traceExtractor: custom })).spanContext, spanContext)
    })
  }

  for (const sampleMode of [-1, 0, 1, 2]) {
    it(`preserves numeric custom sampling priority ${sampleMode}`, async () => {
      const result = await extract({}, {}, { traceExtractor: () => ({ ...customContext, sampleMode }) })
      assert.strictEqual(result.spanContext._sampling.priority, sampleMode)
    })
  }

  it('gives Durable precedence over headers and falls back to Lambda context, not another event extractor', () => {
    const result = extract({ DurableExecutionArn: 'arn', headers }, { clientContext: { custom: headers } })
    assert.strictEqual(result.spanContext, spanContext)
    sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', headers)
  })

  it('gives HTTP precedence over SNS, then tries Lambda context after unsuccessful HTTP extraction', () => {
    tracer.extract.onFirstCall().returns(null)
    const result = extract({ headers: {}, Records: [{ Sns: { MessageAttributes: { _datadog: snsAttribute } } }] },
      { clientContext: { custom: headers } })
    assert.strictEqual(result.spanContext, spanContext)
    assert.deepStrictEqual(tracer.extract.args, [['text_map', {}], ['text_map', headers]])
  })

  it('uses Step Functions before Lambda context after unsuccessful event extraction', () => {
    tracer.extract.returns(null)
    const result = extract({ ...stepEvent, headers: {} }, { clientContext: { custom: headers } })
    assert.strictEqual(result.spanContext.toTraceId(), '1139193989631387307')
    sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', {})
  })

  for (const [name, event] of [
    ['SNS', {
      Records: [{ Sns: { MessageAttributes: { _datadog: { Type: 'String', Value: JSON.stringify(stepEvent) } } } }],
    }],
    ['SQS', {
      Records: [{
        eventSource: 'aws:sqs',
        messageAttributes: { _datadog: { stringValue: JSON.stringify(stepEvent) } },
      }],
    }],
    ['EventBridge', { 'detail-type': 'test', detail: { _datadog: stepEvent } }],
    ['EventBridge-SQS', {
      Records: [{
        eventSource: 'aws:sqs',
        body: JSON.stringify({
          'detail-type': 'test',
          detail: { _datadog: stepEvent },
        }),
      }],
    }],
  ]) {
    it(`extracts Step Functions context from ${name} messages`, () => {
      tracer.extract.returns(null)
      const result = extract(event)
      assert.strictEqual(result.spanContext.toTraceId(), '1139193989631387307')
      assert.strictEqual(result.spanContext.toSpanId(), '7747304477664363642')
      assert.strictEqual(result.source, 'event')
    })
  }

  it('preserves first-use Step Functions caching within one extraction', () => {
    tracer.extract.returns(null)
    const result = extract({ ...stepEvent, 'detail-type': 'test', detail: { _datadog: {} } })
    assert.strictEqual(result.spanContext, null)
  })

  for (const name of ['SNS', 'SNS-SQS', 'SQS']) {
    it(`uses the source Java AWS-header fallback for ${name}`, () => {
      tracer.extract.returns(null)
      process.env._X_AMZN_TRACE_ID = javaHeader
      const event = name === 'SNS'
        ? { Records: [{ Sns: {} }] }
        : {
            Records: [{
              eventSource: 'aws:sqs',
              attributes: { AWSTraceHeader: javaHeader },
              body: name === 'SNS-SQS' ? JSON.stringify({ Type: 'Notification', TopicArn: 'topic' }) : '',
            }],
          }
      const result = extract(event)
      assert.strictEqual(result.spanContext.toTraceId(), '5027664352514971920')
      assert.strictEqual(result.spanContext.toSpanId(), '1797917631284315439')
      assert.strictEqual(result.spanContext._sampling.priority, 1)
      assert.strictEqual(result.source, 'event')
    })
  }

  it('keeps SNS/SQS/Kinesis first-record behavior when later records are traced', () => {
    tracer.extract.returns(null)
    for (const event of [
      { Records: [{ Sns: {} }, { Sns: { MessageAttributes: { _datadog: snsAttribute } } }] },
      { Records: [{ eventSource: 'aws:sqs' }, sqsRecord] },
      { Records: [{ kinesis: {} }, { kinesis: { data: encode({ _datadog: headers }) } }] },
    ]) assert.strictEqual(extract(event).spanContext, null)
    sinon.assert.notCalled(tracer.extract)
  })

  it('falls back to X-Ray only after event, Step Functions and Lambda context', () => {
    tracer.extract.returns(null)
    process.env._X_AMZN_TRACE_ID = 'Root=1-5e272390-8c398be037738dc042009320;Parent=94ae789b969f1cc5;Sampled=1'
    const result = extract({ headers }, { clientContext: { custom: headers } })
    assert.strictEqual(result.source, 'xray')
    assert.strictEqual(result.spanContext.toTraceId(), '3995693151288333088')
    assert.strictEqual(result.spanContext.toSpanId(), '10713633173203262661')
    assert.strictEqual(result.spanContext._sampling.priority, 2)
    sinon.assert.calledTwice(tracer.extract)
  })
})

describe('Lambda HTTP extraction', () => {
  it('flattens the source ALB multi-value fixture and ignores non-string single headers', () => {
    const event = require('../fixtures/application-load-balancer-multivalue-headers.json')
    const tracer = { extract: sinon.stub().returns(null) }
    extractHTTP(event, tracer)
    const expected = Object.fromEntries(Object.entries(event.multiValueHeaders).map(([key, value]) =>
      [key.toLowerCase(), value[0] ?? '']))
    sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', expected)
    tracer.extract.resetHistory()
    extractHTTP({ headers: { 'X-Test': 'yes', number: 1, absent: null, empty: [], multi: ['first', 'last'] } }, tracer)
    sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', { 'x-test': 'yes', empty: '', multi: 'first' })
  })

  for (const type of ['rest', 'http', 'websocket']) {
    for (const cached of [false, true]) {
      it(`decodes ${cached ? 'cached matching-request' : 'uncached'} ${type} authorizer context`, () => {
        const injected = { ...headers, 'x-datadog-authorizing-requestid': 'request' }
        const raw = Buffer.from(JSON.stringify(injected)).toString('base64')
        const event = {
          headers,
          requestContext: {
            stage: 'test',
            domainName: 'example.com',
            requestId: 'request',
            authorizer: { _datadog: raw, lambda: { _datadog: raw }, integrationLatency: cached ? 0 : 1 },
          },
        }
        if (type === 'rest') Object.assign(event, { httpMethod: 'GET', resource: '/' })
        if (type === 'http') Object.assign(event, { version: '2.0', rawQueryString: '' })
        if (type === 'websocket') event.requestContext.messageDirection = 'IN'
        assert.deepStrictEqual(getInjectedAuthorizerHeaders(event), injected)
        const tracer = { extract: sinon.stub().returns(null) }
        assert.strictEqual(extractHTTP(event, tracer), null)
        // An applicable authorizer with no context does not fall through to HTTP headers.
        sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', injected)
        event.requestContext.authorizer.integrationLatency = 0
        event.requestContext.requestId = 'other'
        assert.strictEqual(getInjectedAuthorizerHeaders(event), null)
      })
    }
  }

  for (const authorizer of [{ _datadog: 'invalid' }, { _datadog: Buffer.from('{}').toString('base64') }, {}]) {
    it('uses HTTP headers when authorizer metadata is missing, invalid or cached for another request', () => {
      const tracer = { extract: sinon.stub().returns(null) }
      extractHTTP({ headers, requestContext: { authorizer, requestId: 'different' } }, tracer)
      sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', headers)
    })
  }

  it('honors the authorizer decode switch', () => {
    const tracer = { extract: sinon.stub().returns(null) }
    extractHTTP({
      headers,
      requestContext: {
        authorizer: {
          integrationLatency: 1, _datadog: Buffer.from(JSON.stringify({ other: 'carrier' })).toString('base64'),
        },
      },
    }, tracer, false)
    sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', headers)
  })
})

describe('Lambda MSK extraction', () => {
  for (const carrier of [headers, {
    traceparent: '00-0123456789abcdef0942c4f3b84c8812-12becbb3b2d5bd74-01',
    tracestate: 'dd=s:1;t.dm:-0',
  }, { ...headers, baggage: 'city=São Paulo' }]) {
    it('decodes all header bytes with UTF-8 and passes them to propagation', () => {
      const sentinel = {}
      const tracer = { extract: sinon.stub().returns(sentinel) }
      assert.strictEqual(extractMSK(mskEvent({ 'topic-0': [mskRecord(carrier)] }), tracer), sentinel)
      sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', carrier)
    })
  }

  it('uses the last duplicate value, normalizes names and preserves the event', () => {
    const event = mskEvent({ 'topic-0': [{ headers: [{ TRACEPARENT: [49] }, { TraceParent: [50] }] }] })
    const original = structuredClone(event)
    const tracer = { extract: sinon.stub().returns(null) }
    extractMSK(event, tracer)
    sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', { traceparent: '2' })
    assert.deepStrictEqual(event, original)
  })

  it('skips failures across partitions and stops at the first traced record without combining headers', () => {
    const sentinel = {}
    const tracer = { extract: sinon.stub().returns(null) }
    tracer.extract.onCall(0).throws(new Error('invalid'))
    tracer.extract.onCall(2).returns(sentinel)
    assert.strictEqual(extractMSK(mskEvent({
      'topic-0': [{}, mskRecord({ 'x-datadog-trace-id': '123' })],
      'topic-1': [mskRecord({ 'x-datadog-parent-id': '456' }), mskRecord(headers), mskRecord(headers)],
    }), tracer), sentinel)
    assert.deepStrictEqual(tracer.extract.args, [
      ['text_map', { 'x-datadog-trace-id': '123' }],
      ['text_map', { 'x-datadog-parent-id': '456' }], ['text_map', headers],
    ])
  })

  for (const records of [undefined, null, 'invalid', {}, { topic: [] }, { topic: null }, { topic: 'invalid' },
    { topic: [null, {}, { headers: null }, { headers: 'invalid' }, { headers: [null, 42, []] }] }]) {
    it(`skips malformed records: ${JSON.stringify(records)}`, () => {
      const tracer = { extract: sinon.stub().returns(null) }
      assert.strictEqual(extractMSK(mskEvent(records), tracer), null)
      sinon.assert.notCalled(tracer.extract)
    })
  }

  for (const value of [null, '123', { 0: 49 }]) {
    it(`skips non-array header values: ${JSON.stringify(value)}`, () => {
      const tracer = { extract: sinon.stub().returns(null) }
      extractMSK(mskEvent({ topic: [{ headers: [{ invalid: value }, ...mskRecord(headers).headers] }] }), tracer)
      sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', headers)
    })
  }
})

describe('Lambda Durable Execution extraction', () => {
  it('selects the highest checkpoint and prefers Payload to StepDetails.Result', () => {
    const tracer = { extract: sinon.stub().returns(null) }
    extractDurableExecution({
      DurableExecutionArn: 'arn',
      InitialExecutionState: {
        Operations: [
          { Name: '_datadog_0', Payload: '{}' },
          { Name: '_datadog_2', Payload: JSON.stringify(headers), StepDetails: { Result: '{}' } },
          { Name: '_datadog_1', Payload: '{}' },
          ...['_datadog_3x', '_datadog_03', '_datadog_', 'other', undefined].map(Name =>
            ({ Name, Payload: '{}' })),
        ],
      },
    }, tracer)
    sinon.assert.calledOnceWithExactly(tracer.extract, 'text_map', headers)
  })

  for (const raw of [undefined, '', 'invalid', 'null', '1']) {
    it(`does not fall back to an older checkpoint if the latest is invalid: ${raw}`, () => {
      const tracer = { extract: sinon.stub().returns(null) }
      assert.strictEqual(extractDurableExecution({
        DurableExecutionArn: 'arn',
        InitialExecutionState: {
          Operations: [
            { Name: '_datadog_0', Payload: JSON.stringify(headers) }, { Name: '_datadog_1', Payload: raw },
          ],
        },
      }, tracer), null)
      sinon.assert.notCalled(tracer.extract)
    })
  }

  for (const event of [{}, { DurableExecutionArn: '' }, { DurableExecutionArn: 'arn' },
    { DurableExecutionArn: 'arn', InitialExecutionState: { Operations: [] } }]) {
    it('returns no parent when no trace checkpoint exists', () => {
      const tracer = { extract: sinon.stub().returns(null) }
      assert.strictEqual(extractDurableExecution(event, tracer), null)
      sinon.assert.notCalled(tracer.extract)
    })
  }
})
