'use strict'

const assert = require('node:assert/strict')
const { gzipSync } = require('node:zlib')

const { describe, it } = require('mocha')

const {
  parseEventSource, parseEventSourceSubtype, parseEventSourceARN, extractTriggerTags, extractHTTPStatusCodeTag,
} = require('../src/trigger')

const context = { invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:example:alias' }

/** @param {string} name */
function fixture (name) {
  return JSON.parse(JSON.stringify(require(`./fixtures/${name}.json`)))
}

describe('Lambda trigger boundaries', () => {
  it('preserves the complete classification precedence for overlapping event shapes', () => {
    const event = {
      requestContext: { domainName: 'a.lambda-url.us-east-1', messageDirection: 'IN', elb: {} },
      awslogs: {},
      source: 'aws.events',
      Records: [{ cf: {}, dynamodb: {}, kinesis: {}, s3: {}, Sns: {}, eventSource: 'aws:sqs' }],
      'detail-type': 'event',
      Execution: {},
      State: {},
      StateMachine: {},
    }
    const stages = [
      ['lambda-function-url', () => { event.requestContext.domainName = 'example.com' }],
      ['api-gateway', () => { delete event.requestContext.messageDirection }],
      ['application-load-balancer', () => { delete event.requestContext }],
      ['cloudwatch-logs', () => { delete event.awslogs }],
      ['cloudwatch-events', () => { delete event.source }],
      ['cloudfront', () => { delete event.Records[0].cf }],
      ['dynamodb', () => { delete event.Records[0].dynamodb }],
      ['kinesis', () => { delete event.Records[0].kinesis }],
      ['s3', () => { delete event.Records[0].s3 }],
      ['sns', () => { delete event.Records[0].Sns }],
      ['sqs', () => { delete event.Records }],
      ['eventbridge', () => { delete event['detail-type'] }],
      ['states', () => { delete event.Execution }],
    ]
    for (const [source, remove] of stages) {
      assert.strictEqual(parseEventSource(event), source)
      remove()
    }
    assert.strictEqual(parseEventSource(event), undefined)
  })

  it('preserves REST, HTTP, WebSocket subtype precedence independently of URL classification', () => {
    const event = {
      requestContext: { stage: '', domainName: 'example.com', messageDirection: '' },
      httpMethod: '',
      resource: '',
      version: '2.0',
      rawQueryString: '',
    }
    assert.strictEqual(parseEventSourceSubtype(event), 'api-gateway-rest-api')
    event.requestContext.domainName = 'a.lambda-url.us-east-1'
    assert.strictEqual(parseEventSource(event), 'lambda-function-url')
    assert.strictEqual(parseEventSourceSubtype(event), 'api-gateway-rest-api')
    event.requestContext.domainName = 'example.com'
    delete event.resource
    assert.strictEqual(parseEventSourceSubtype(event), 'api-gateway-http-api')
    delete event.version
    assert.strictEqual(parseEventSourceSubtype(event), 'api-gateway-websocket')
    delete event.requestContext.messageDirection
    assert.strictEqual(parseEventSourceSubtype(event), 'unknown-sub-type')
  })

  it('keeps WebSocket trigger tags without inventing HTTP request tags', () => {
    const event = fixture('api-gateway-wss')
    assert.strictEqual(parseEventSourceSubtype(event), 'api-gateway-websocket')
    assert.deepStrictEqual(extractTriggerTags(event, context, parseEventSource(event)), {
      'function_trigger.event_source': 'api-gateway',
      'function_trigger.event_source_arn': 'arn:aws:apigateway:us-east-1::/restapis/08se3mvh28/stages/dev',
    })
  })

  for (const name of ['snssqs', 'eventbridge-sqs']) {
    it(`keeps ${name} classified and tagged as the outer SQS trigger`, () => {
      const event = fixture(name)
      assert.strictEqual(parseEventSource(event), 'sqs')
      assert.deepStrictEqual(extractTriggerTags(event, context, 'sqs'), {
        'function_trigger.event_source': 'sqs',
        'function_trigger.event_source_arn': event.Records[0].eventSourceARN,
      })
    })
  }

  it('uses EventBridge source verbatim as the source ARN', () => {
    const event = fixture('eventbridge')
    assert.strictEqual(parseEventSource(event), 'eventbridge')
    assert.deepStrictEqual(extractTriggerTags(event, context, 'eventbridge'), {
      'function_trigger.event_source': 'eventbridge',
      'function_trigger.event_source_arn': 'my.event',
    })
  })

  it('does not invent trigger names for MSK, Durable or AppSync predicates', () => {
    for (const event of [
      { eventSource: 'aws:kafka', records: {} }, { DurableExecutionArn: 'execution' },
      { info: { selectionSetGraphQL: 'query' } },
    ]) {
      assert.strictEqual(parseEventSource(event), undefined)
      assert.deepStrictEqual(extractTriggerTags(event, context, parseEventSource(event)), {})
    }
  })

  it('extracts the state-machine ARN through each supported envelope', () => {
    const state = fixture('states')._datadog
    for (const event of [state, { Payload: state }, { _datadog: state }, { Payload: { _datadog: state } }]) {
      assert.strictEqual(parseEventSource(event), 'states')
      assert.strictEqual(parseEventSourceARN('states', event, context), state.StateMachine.Id)
    }
    assert.throws(() => parseEventSourceARN('states', { Payload: null }, context), { name: 'TypeError' })
    assert.throws(() => parseEventSourceARN('states', { _datadog: null }, context), { name: 'TypeError' })
  })

  for (const [region, partition] of [['us-east-1', 'aws'], ['us-gov-west-1', 'aws-us-gov'], ['cn-north-1', 'aws-cn']]) {
    it(`constructs ${partition} ARNs using the invocation region and account`, () => {
      // The source derives partition from region, not from the partition text in the function ARN.
      const regional = { invokedFunctionArn: `arn:other:lambda:${region}:123:function:example` }
      assert.strictEqual(parseEventSourceARN('api-gateway', {
        requestContext: { apiId: 'api', stage: 'stage' },
      }, regional), `arn:${partition}:apigateway:${region}::/restapis/api/stages/stage`)
      assert.strictEqual(parseEventSourceARN('cloudfront', fixture('cloudfront'), regional),
        `arn:${partition}:cloudfront::123:distribution/EXAMPLE`)
      assert.strictEqual(parseEventSourceARN('cloudwatch-logs', fixture('cloudwatch-logs'), regional),
        `arn:${partition}:logs:${region}:123:log-group:testLogGroup`)
      assert.strictEqual(parseEventSourceARN('s3', fixture('s3'), regional), 'arn:aws:s3:::example-bucket')
    })
  }

  for (const name of ['api-gateway-v1', 'api-gateway-v2', 'application-load-balancer', 'lambda-function-urls']) {
    it(`keeps ${name} Referer case sensitivity and input immutability`, () => {
      const event = fixture(name)
      event.headers = { Referer: 'https://ref.example', referer: 'https://lower.example' }
      const before = JSON.stringify(event)
      const source = parseEventSource(event)
      assert.strictEqual(extractTriggerTags(event, context, source)['http.referer'], 'https://ref.example')
      assert.strictEqual(JSON.stringify(event), before)
      delete event.headers.Referer
      assert.strictEqual(extractTriggerTags(event, context, source)['http.referer'], undefined)
    })
  }

  it('preserves absent HTTP paths, REST domain handling and HTTP route parsing', () => {
    const rest = { requestContext: { stage: 'stage', httpMethod: 'GET' }, httpMethod: 'POST', resource: '/resource' }
    const restTags = extractTriggerTags(rest, context, 'api-gateway')
    assert.strictEqual(restTags['http.url'], undefined)
    assert.strictEqual(restTags['http.url_details.path'], undefined)
    assert.strictEqual(restTags['http.method'], 'GET')
    assert.strictEqual(restTags['http.route'], '/resource')
    rest.requestContext.domainName = 'example.com'
    assert.strictEqual(extractTriggerTags(rest, context, 'api-gateway')['http.url'], 'https://example.com')
    const http = {
      requestContext: { domainName: 'example.com', http: { method: 'GET' } },
      version: '2.0',
      rawQueryString: '',
      routeKey: 'GET /my/{id}',
    }
    const tags = extractTriggerTags(http, context, 'api-gateway')
    assert.strictEqual(tags['http.url'], 'https://example.com')
    assert.strictEqual(tags['http.url_details.path'], undefined)
    assert.strictEqual(tags['http.route'], '/my/{id}')
    http.routeKey = '$default'
    assert.strictEqual(extractTriggerTags(http, context, 'api-gateway')['http.route'], '$default')
  })

  it('retains available tags when ARN decoding or HTTP extraction fails', () => {
    for (const data of ['not-gzip', gzipSync('not-json').toString('base64')]) {
      assert.deepStrictEqual(extractTriggerTags({ awslogs: { data } }, context, 'cloudwatch-logs'), {
        'function_trigger.event_source': 'cloudwatch-logs',
      })
    }
    const event = {
      requestContext: { apiId: 'api', stage: 'stage', domainName: 'example.com' },
      version: '2.0',
      rawQueryString: '',
    }
    assert.deepStrictEqual(extractTriggerTags(event, context, 'api-gateway'), {
      'function_trigger.event_source': 'api-gateway',
      'function_trigger.event_source_arn': 'arn:aws:apigateway:us-east-1::/restapis/api/stages/stage',
    })
    const alb = fixture('application-load-balancer')
    const tags = extractTriggerTags(alb, { invokedFunctionArn: 'malformed' }, 'application-load-balancer')
    assert.deepStrictEqual(tags, {
      'function_trigger.event_source': 'application-load-balancer',
      'http.url_details.path': '/lambda',
      'http.method': 'GET',
    })
  })

  it('keeps HTTP status truthiness and buffered versus streaming undefined results', () => {
    for (const source of ['api-gateway', 'application-load-balancer', 'lambda-function-url']) {
      const tags = { 'function_trigger.event_source': source }
      for (const streaming of [false, true]) {
        assert.strictEqual(extractHTTPStatusCodeTag(tags, undefined, streaming), streaming ? '200' : '502')
        for (const result of [null, {}, { statusCode: 0 }, { statusCode: '' }]) {
          assert.strictEqual(extractHTTPStatusCodeTag(tags, result, streaming), '200')
        }
        for (const statusCode of [500, '201', '0']) {
          assert.strictEqual(extractHTTPStatusCodeTag(tags, { statusCode }, streaming), String(statusCode))
        }
      }
    }
    for (const tags of [undefined, {}, { 'function_trigger.event_source': 'sqs' }]) {
      assert.strictEqual(extractHTTPStatusCodeTag(tags, { statusCode: 500 }, false), undefined)
    }
  })
})
