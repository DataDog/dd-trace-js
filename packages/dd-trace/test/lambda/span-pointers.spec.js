'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { HANDLER_STREAMING, STREAM_RESPONSE } = require('../../../datadog-instrumentations/src/helpers/lambda-handler')
const aws = require('../../../datadog-plugin-aws-sdk/src/util')
const agent = require('../plugins/agent')
const { assertExactlyOneLambdaSpan } = require('./helpers')

const context = { functionName: 'pointer-test', awsRequestId: 'request', getRemainingTimeInMillis: () => 30_000 }

function fixture (name) {
  return structuredClone(require('../../../datadog-plugin-aws-lambda/test/fixtures/' + name + '.json'))
}

function links (span) {
  return JSON.parse(span.meta['_dd.span_links'] || '[]')
}

function expectedPointers (name, event) {
  return event.Records.map(record => {
    if (name === 's3') {
      const { bucket, object } = record.s3
      const eTag = object.eTag.startsWith('"') && object.eTag.endsWith('"') ? object.eTag.slice(1, -1) : object.eTag
      return {
        'ptr.kind': 'aws.s3.object',
        'ptr.dir': 'u',
        'ptr.hash': aws.generatePointerHash([bucket.name, object.key, eTag]),
        'link.kind': 'span-pointer',
      }
    }
    const keys = record.dynamodb.Keys
    const table = /table\/([^/]*)/.exec(record.eventSourceARN)[1]
    return {
      'ptr.kind': 'aws.dynamodb.item',
      'ptr.dir': 'u',
      'ptr.hash': aws.generatePointerHash([table, ...aws.extractPrimaryKeys(Object.keys(keys), keys)]),
      'link.kind': 'span-pointer',
    }
  })
}

describe('Lambda span pointer lifecycle', () => {
  const oldEnv = process.env
  let tracer, facade, traces, clock

  beforeEach(() => {
    process.env = { ...oldEnv, AWS_LAMBDA_FUNCTION_NAME: context.functionName, DD_TRACE_ENABLED: 'true' }
    for (const key of ['_X_AMZN_TRACE_ID', 'AWS_XRAY_DAEMON_ADDRESS', 'DD_TRACE_AWS_ADD_SPAN_POINTERS',
      'DD_CAPTURE_LAMBDA_PAYLOAD', 'DD_LOGS_INJECTION']) delete process.env[key]
    tracer = undefined; clock = undefined; traces = []
  })

  afterEach(async () => {
    clock?.restore()
    if (tracer) await agent.close({ ritmReset: false })
    sinon.restore()
    process.env = oldEnv
  })

  async function init (pluginConfig = {}) {
    if (tracer) return
    tracer = await agent.load('aws-lambda', pluginConfig, { experimental: { exporter: 'agent' } })
    delete require.cache[require.resolve('../../src/lambda/facade')]
    facade = require('../../src/lambda/facade')
    sinon.stub(tracer._tracer._exporter, 'export').callsFake(trace => traces.push(trace))
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  }

  function assertPointers (expected, targetName) {
    const lambda = assertExactlyOneLambdaSpan(traces)
    const spans = traces.flat()
    const root = spans.find(span => span.name === targetName)
    assert.ok(root)
    const pointers = links(root)
    assert.deepStrictEqual(pointers.map(link => link.attributes), expected)
    for (const pointer of pointers) {
      assert.strictEqual(BigInt('0x' + pointer.trace_id), 0n)
      assert.strictEqual(BigInt('0x' + pointer.span_id), 0n)
    }
    for (const span of spans) if (span !== root) assert.deepStrictEqual(links(span), [])
    assert.strictEqual(clock.countTimers(), 0)
    return lambda
  }

  async function invoke (event, options = {}, result = {}, pluginConfig = {}) {
    await init(pluginConfig)
    const wrapped = facade.wrap(() => result, { injectLogContext: false, ...options })
    assert.strictEqual(await wrapped(event, { ...context }), result)
  }

  for (const name of ['s3', 'dynamodb']) {
    for (const createInferredSpan of [false, true]) {
      for (const addSpanPointers of [false, true]) {
        it(`attaches ${name} pointers with inferred=${createInferredSpan}, enabled=${addSpanPointers}`, async () => {
          const input = fixture(name)
          const expected = addSpanPointers ? expectedPointers(name, input) : []
          const original = structuredClone(input)
          await invoke(input, { createInferredSpan, addSpanPointers })
          assertPointers(expected, createInferredSpan ? 'aws.' + name : 'aws.lambda')
          assert.deepStrictEqual(input, original)
        })
      }
    }
  }

  for (const eventName of ['ObjectCreated:Put', 'ObjectCreated:Copy', 'ObjectCreated:CompleteMultipartUpload',
    'ObjectRemoved:Delete', 'ObjectRestore:Completed']) {
    it(`preserves the S3 event filter through export for ${eventName}`, async () => {
      const input = fixture('s3'); input.Records[0].eventName = eventName
      await invoke(input)
      assertPointers(eventName.startsWith('ObjectCreated') ? expectedPointers('s3', input) : [], 'aws.s3')
    })
  }

  for (const eventName of ['INSERT', 'MODIFY', 'REMOVE', 'UPDATE']) {
    it(`preserves the DynamoDB event filter through export for ${eventName}`, async () => {
      const input = fixture('dynamodb'); input.Records = [input.Records[0]]; input.Records[0].eventName = eventName
      await invoke(input)
      assertPointers(eventName === 'UPDATE' ? [] : expectedPointers('dynamodb', input), 'aws.dynamodb')
    })
  }

  for (const name of ['s3', 'dynamodb']) {
    it(`keeps duplicate ${name} records and source order`, async () => {
      const input = fixture(name); input.Records = [input.Records[0], structuredClone(input.Records[0])]
      await invoke(input)
      assertPointers(expectedPointers(name, input), 'aws.' + name)
    })

    it(`calculates ${name} pointers before the handler mutates the event`, async () => {
      await init()
      const input = fixture(name)
      const expected = expectedPointers(name, input)
      const wrapped = facade.wrap(async event => {
        for (const record of event.Records) {
          if (name === 's3') record.s3.object.key = 'changed by customer'
          else record.dynamodb.Keys = { changed: { S: 'customer value' } }
        }
        return 'done'
      }, { injectLogContext: false, createInferredSpan: false })
      assert.strictEqual(await wrapped(input, { ...context }), 'done')
      assertPointers(expected, 'aws.lambda')
    })

    for (const completion of ['sync', 'promise', 'callback', 'throw', 'reject', 'streaming']) {
      it(`keeps ${name} pointers and customer outcome for ${completion}`, async () => {
        await init()
        const input = fixture(name); const result = { done: true }; const failure = Error('customer failure')
        let handler
        if (completion === 'callback') handler = (event, ctx, callback) => callback(null, result)
        else if (completion === 'throw') handler = () => { throw failure }
        else if (completion === 'reject') handler = async () => { throw failure }
        else if (completion === 'promise' || completion === 'streaming') handler = async () => result
        else handler = () => result
        if (completion === 'streaming') handler[HANDLER_STREAMING] = STREAM_RESPONSE
        const wrapped = facade.wrap(handler, { injectLogContext: false })
        const pending = completion === 'streaming'
          ? wrapped(input, {}, { ...context })
          : wrapped(input, { ...context })
        if (completion === 'throw' || completion === 'reject') await assert.rejects(pending, error => error === failure)
        else assert.strictEqual(await pending, result)
        const lambda = assertPointers(expectedPointers(name, input), 'aws.' + name)
        assert.strictEqual(lambda.error, completion === 'throw' || completion === 'reject' ? 1 : 0)
      })
    }
  }

  for (const enabled of [false, true]) {
    it(`honors DD_TRACE_AWS_ADD_SPAN_POINTERS=${enabled}`, async () => {
      process.env.DD_TRACE_AWS_ADD_SPAN_POINTERS = String(enabled)
      const input = fixture('s3')
      await invoke(input)
      assertPointers(enabled ? expectedPointers('s3', input) : [], 'aws.s3')
    })

    it(`uses per-handler addSpanPointers=${enabled} over the opposite plugin setting`, async () => {
      const input = fixture('dynamodb')
      await invoke(input, { addSpanPointers: enabled }, {}, { addSpanPointers: !enabled })
      assertPointers(enabled ? expectedPointers('dynamodb', input) : [], 'aws.dynamodb')
    })
  }

  it('does no hashing while disabled', async () => {
    const hash = sinon.spy(aws, 'generatePointerHash')
    await invoke(fixture('s3'), { addSpanPointers: false })
    assert.strictEqual(hash.callCount, 0)
    assertPointers([], 'aws.s3')
  })

  it('does not treat nested S3 payloads in SQS as direct notifications', async () => {
    const input = fixture('sqs'); input.Records[0].body = JSON.stringify(fixture('s3'))
    await invoke(input)
    assertPointers([], 'aws.sqs')
  })

  it('retains classification precedence for HTTP events containing S3 records', async () => {
    const input = { ...fixture('api-gateway-v1'), Records: fixture('s3').Records }
    await invoke(input, {}, { statusCode: 200 })
    assertPointers([], 'aws.apigateway')
  })

  it('does not search later records to change an unclassified batch into S3', async () => {
    await invoke({ Records: [{}, ...fixture('s3').Records] })
    assertPointers([], 'aws.lambda')
  })

  it('does not carry pointer state across warm trigger changes', async () => {
    await init()
    const wrapped = facade.wrap(async () => 'done', { injectLogContext: false })
    for (const name of ['s3', 'dynamodb', undefined]) {
      traces.length = 0
      const input = name ? fixture(name) : {}
      assert.strictEqual(await wrapped(input, { ...context }), 'done')
      assertPointers(name ? expectedPointers(name, input) : [], name ? 'aws.' + name : 'aws.lambda')
    }
  })

  for (const throws of [false, true]) {
    it(`contains pointer preparation failure and preserves the customer ${throws ? 'error' : 'result'}`, async () => {
      await init()
      sinon.stub(aws, 'generatePointerHash').throws(Error('hash failure'))
      const result = {}
      const failure = Error('customer failure')
      const wrapped = facade.wrap(() => {
        if (throws) throw failure
        return result
      }, { injectLogContext: false })
      const pending = wrapped(fixture('s3'), { ...context })
      if (throws) await assert.rejects(pending, error => error === failure)
      else assert.strictEqual(await pending, result)
      assertPointers([], 'aws.s3')
    })

    it(`preserves the customer ${throws ? 'error' : 'result'} and continues after a pointer API failure`, async () => {
      await init()
      const input = fixture('s3')
      const second = structuredClone(input.Records[0])
      second.s3.object.key = 'second'; input.Records.push(second)
      const expected = expectedPointers('s3', input).slice(1)
      const result = {}
      const failure = Error('customer failure')
      const wrapped = facade.wrap(() => {
        const span = tracer.scope().active()
        sinon.stub(span, 'addSpanPointer').callThrough().onFirstCall().throws(Error('pointer API failure'))
        if (throws) throw failure
        return result
      }, { injectLogContext: false, createInferredSpan: false })
      const pending = wrapped(input, { ...context })
      if (throws) await assert.rejects(pending, error => error === failure)
      else assert.strictEqual(await pending, result)
      assertPointers(expected, 'aws.lambda')
    })
  }

  it('does no pointer work when the Lambda plugin is disabled', async () => {
    await init()
    tracer.use('aws-lambda', false)
    const hash = sinon.spy(aws, 'generatePointerHash')
    const wrapped = facade.wrap(async () => 'done')
    assert.strictEqual(await wrapped(fixture('s3'), { ...context }), 'done')
    assert.strictEqual(hash.callCount, 0)
    assert.strictEqual(traces.flat().length, 0)
  })
})
