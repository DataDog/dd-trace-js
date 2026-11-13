'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const { describe, it } = require('mocha')

const {
  parseEventSource, parseEventSourceARN, extractTriggerTags, extractHTTPStatusCodeTag,
} = require('../src/trigger')

const mockARN = 'arn:aws:lambda:us-east-1:123456789012:function:test-nodejs-lambda'
const mockContext = {
  invokedFunctionArn: mockARN,
}
describe('parseEventSource', () => {
  const events = [
    {
      result: {
        'function_trigger.event_source': 'api-gateway',
        'function_trigger.event_source_arn':
          'arn:aws:apigateway:us-east-1::/restapis/id/stages/$default',
        'http.url': 'https://id.execute-api.us-east-1.amazonaws.com/my/path',
        'http.url_details.path': '/my/path',
        'http.method': 'GET',
        'http.route': '/my/path',
      },
      file: 'api-gateway-v1.json',
    },
    {
      result: {
        'function_trigger.event_source': 'api-gateway',
        'function_trigger.event_source_arn':
          'arn:aws:apigateway:us-east-1::/restapis/r3pmxmplak/stages/default',
        'http.url': 'https://r3pmxmplak.execute-api.us-east-2.amazonaws.com/default/nodejs-apig-function-1G3XMPLZXVXYI',
        'http.url_details.path': '/default/nodejs-apig-function-1G3XMPLZXVXYI',
        'http.method': 'GET',
        'http.route': '/nodejs-apig-function-1G3XMPLZXVXYI',
      },
      file: 'api-gateway-v2.json',
    },
    {
      result: {
        'function_trigger.event_source': 'lambda-function-url',
        'http.url': 'https://a8hyhsshac.lambda-url.eu-south-1.amazonaws.com/',
        'http.url_details.path': '/',
        'http.method': 'GET',
      },
      file: 'lambda-function-urls.json',
    },
    {
      result: {
        'function_trigger.event_source': 'application-load-balancer',
        'function_trigger.event_source_arn':
          'arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/lambda-xyz/123abc',
        'http.url_details.path': '/lambda',
        'http.method': 'GET',
      },
      file: 'application-load-balancer.json',
    },
    {
      result: {
        'function_trigger.event_source': 'cloudfront',
        'function_trigger.event_source_arn':
          'arn:aws:cloudfront::123456789012:distribution/EXAMPLE',
      },
      file: 'cloudfront.json',
    },
    {
      result: {
        'function_trigger.event_source': 'cloudwatch-events',
        'function_trigger.event_source_arn':
          'arn:aws:events:us-east-1:123456789012:rule/ExampleRule',
      },
      file: 'cloudwatch-events.json',
    },
    {
      result: {
        'function_trigger.event_source': 'cloudwatch-logs',
        'function_trigger.event_source_arn':
          'arn:aws:logs:us-east-1:123456789012:log-group:testLogGroup',
      },
      file: 'cloudwatch-logs.json',
    },
    { result: {}, file: 'custom.json' },
    {
      result: {
        'function_trigger.event_source': 'dynamodb',
        'function_trigger.event_source_arn':
          'arn:aws:dynamodb:us-east-1:123456789012:table/ExampleTableWithStream/stream/2015-06-27T00:48:05.899',
      },
      file: 'dynamodb.json',
    },
    {
      result: {
        'function_trigger.event_source': 'kinesis',
        'function_trigger.event_source_arn':
          'arn:aws:kinesis:EXAMPLE',
      },
      file: 'kinesis.json',
    },
    {
      result: {
        'function_trigger.event_source': 's3',
        'function_trigger.event_source_arn':
          'arn:aws:s3:::example-bucket',
      },
      file: 's3.json',
    },
    {
      result: {
        'function_trigger.event_source': 'sns',
        'function_trigger.event_source_arn':
          'arn:aws:sns:us-east-1:123456789012:ExampleTopic',
      },
      file: 'sns.json',
    },
    {
      result: {
        'function_trigger.event_source': 'sqs',
        'function_trigger.event_source_arn':
          'arn:aws:sqs:us-east-1:123456789012:MyQueue',
      },
      file: 'sqs.json',
    },
    {
      result: {
        'function_trigger.event_source': 'states',
        'function_trigger.event_source_arn':
          'arn:aws:states:ca-central-1:425362996713:stateMachine:MyStateMachine-wsx8chv4d',
      },
      file: 'states.json',
    },
  ]
  const bufferedResponses = [
    {
      responseBody: {
        statusCode: 200,
        body: '"Hello from Lambda!"',
      },
      expectedStatusCode: '200',
    },
    {
      responseBody: {
        statusCode: '201',
        body: '"String status code case!"',
      },
      expectedStatusCode: '201',
    },
    {
      responseBody: {
        statusCode: 404,
        body: '"NOT FOUND"',
      },
      expectedStatusCode: '404',
    },
    {
      responseBody: undefined,
      expectedStatusCode: '502',
    },
  ]
  const streamingResponses = [
    {
      responseBody: {
        statusCode: 200,
        body: '"Hello from Lambda!"',
      },
      expectedStatusCode: '200',
    },
    {
      responseBody: {
        statusCode: 404,
        body: '"NOT FOUND"',
      },
      expectedStatusCode: '404',
    },
    {
      responseBody: undefined,
      expectedStatusCode: '200',
    },
  ]
  it('returns the correct event source and ARN', () => {
    for (const event of events) {
      const eventData = JSON.parse(readFileSync(join(__dirname, 'fixtures', event.file), 'utf8'))
      const eventSource = parseEventSource(eventData)
      const eventSourceARN = parseEventSourceARN(eventSource, eventData, mockContext)
      assert.deepStrictEqual(eventSource, event.result['function_trigger.event_source'])
      assert.deepStrictEqual(eventSourceARN, event.result['function_trigger.event_source_arn'])
    }
  })
  it('extracts all trigger tags', () => {
    for (const event of events) {
      const eventData = JSON.parse(readFileSync(join(__dirname, 'fixtures', event.file), 'utf8'))
      const eventSource = parseEventSource(eventData)
      const triggerTags = extractTriggerTags(eventData, mockContext, eventSource)
      assert.deepStrictEqual(triggerTags, event.result)
    }
  })
  it('extracts buffered HTTP status codes only for API Gateway, ALB and Function URL', () => {
    for (const event of events) {
      const eventData = JSON.parse(readFileSync(join(__dirname, 'fixtures', event.file), 'utf8'))
      const eventSource = parseEventSource(eventData)
      const triggerTags = extractTriggerTags(eventData, mockContext, eventSource)
      const isResponseStreamingFunction = false
      for (const response of bufferedResponses) {
        const statusCode = extractHTTPStatusCodeTag(triggerTags, response.responseBody, isResponseStreamingFunction)
        // We should always return a status code for API Gateway, ALB, and Lambda Function URL
        if ([
          'api-gateway-v1.json',
          'api-gateway-v2.json',
          'application-load-balancer.json',
          'lambda-function-urls.json',
        ].includes(event.file)) {
          assert.deepStrictEqual(statusCode, response.expectedStatusCode)
        } else {
          assert.strictEqual(statusCode, undefined)
        }
      }
    }
  })
  it('extracts streaming HTTP status codes only for API Gateway, ALB and Function URL', () => {
    for (const event of events) {
      const eventData = JSON.parse(readFileSync(join(__dirname, 'fixtures', event.file), 'utf8'))
      const eventSource = parseEventSource(eventData)
      const triggerTags = extractTriggerTags(eventData, mockContext, eventSource)
      const isResponseStreamingFunction = true
      for (const response of streamingResponses) {
        const statusCode = extractHTTPStatusCodeTag(triggerTags, response.responseBody, isResponseStreamingFunction)
        // We should always return a status code for API Gateway, ALB, and Lambda Function URL
        if ([
          'api-gateway-v1.json',
          'api-gateway-v2.json',
          'application-load-balancer.json',
          'lambda-function-urls.json',
        ].includes(event.file)) {
          assert.deepStrictEqual(statusCode, response.expectedStatusCode)
        } else {
          assert.strictEqual(statusCode, undefined)
        }
      }
    }
  })
})
