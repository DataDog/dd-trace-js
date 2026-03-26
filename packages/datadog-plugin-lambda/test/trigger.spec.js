'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
const {
  parseEventSource,
  parseEventSourceSubType,
  extractTriggerTags,
  extractHTTPStatusCodeTag,
  isHTTPTriggerEvent,
  eventTypes,
  eventSubTypes,
} = require('../src/trigger')

const mockContext = {
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function',
}

// Sample events
const apiGatewayV1Event = {
  httpMethod: 'GET',
  resource: '/users/{id}',
  headers: { Referer: 'https://example.com' },
  requestContext: {
    stage: 'prod',
    apiId: 'abc123',
    httpMethod: 'GET',
    path: '/prod/users/42',
    domainName: 'abc123.execute-api.us-east-1.amazonaws.com',
  },
}

const apiGatewayV2Event = {
  version: '2.0',
  rawQueryString: '',
  routeKey: 'GET /users/{id}',
  headers: { Referer: 'https://example.com' },
  requestContext: {
    domainName: 'abc123.execute-api.us-east-1.amazonaws.com',
    http: { method: 'GET', path: '/users/42' },
    apiId: 'abc123',
    stage: 'prod',
  },
}

const sqsEvent = {
  Records: [{ eventSource: 'aws:sqs', eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:my-queue', body: 'msg' }],
}

const snsEvent = {
  Records: [{ Sns: { TopicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic', Message: 'hello' } }],
}

const dynamoDBEvent = {
  Records: [{ dynamodb: { Keys: {} }, eventSourceARN: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-table' }],
}

const kinesisEvent = {
  Records: [{ kinesis: { data: 'abc' }, eventSourceARN: 'arn:aws:kinesis:us-east-1:123456789012:stream/my-stream' }],
}

const s3Event = {
  Records: [{ s3: { bucket: { arn: 'arn:aws:s3:::my-bucket', name: 'my-bucket' }, object: { key: 'file.txt' } } }],
}

const eventBridgeEvent = {
  'detail-type': 'MyEvent',
  source: 'my.application',
  detail: {},
}

const lambdaUrlEvent = {
  version: '2.0',
  rawQueryString: '',
  requestContext: {
    domainName: 'abc123.lambda-url.us-east-1.on.aws',
    http: { method: 'POST', path: '/submit' },
  },
}

const albEvent = {
  requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg' } },
  httpMethod: 'GET',
  path: '/health',
}

const stepFunctionsEvent = {
  Execution: { Id: 'arn:aws:states:us-east-1:123456789012:execution:my-sm:my-exec' },
  State: { Name: 'MyState' },
  StateMachine: { Id: 'arn:aws:states:us-east-1:123456789012:stateMachine:my-sm' },
}

const cloudWatchEvent = {
  source: 'aws.events',
  'detail-type': 'Scheduled Event',
  resources: ['arn:aws:events:us-east-1:123456789012:rule/my-rule'],
}

describe('trigger', () => {
  describe('parseEventSource', () => {
    it('returns api-gateway for API Gateway v1', () => {
      assert.equal(parseEventSource(apiGatewayV1Event), eventTypes.apiGateway)
    })

    it('returns api-gateway for API Gateway v2', () => {
      assert.equal(parseEventSource(apiGatewayV2Event), eventTypes.apiGateway)
    })

    it('returns sqs for SQS event', () => {
      assert.equal(parseEventSource(sqsEvent), eventTypes.sqs)
    })

    it('returns sns for SNS event', () => {
      assert.equal(parseEventSource(snsEvent), eventTypes.sns)
    })

    it('returns dynamodb for DynamoDB event', () => {
      assert.equal(parseEventSource(dynamoDBEvent), eventTypes.dynamoDB)
    })

    it('returns kinesis for Kinesis event', () => {
      assert.equal(parseEventSource(kinesisEvent), eventTypes.kinesis)
    })

    it('returns s3 for S3 event', () => {
      assert.equal(parseEventSource(s3Event), eventTypes.s3)
    })

    it('returns eventbridge for EventBridge event', () => {
      assert.equal(parseEventSource(eventBridgeEvent), eventTypes.eventBridge)
    })

    it('returns lambda-function-url for Lambda URL event', () => {
      assert.equal(parseEventSource(lambdaUrlEvent), eventTypes.lambdaUrl)
    })

    it('returns application-load-balancer for ALB event', () => {
      assert.equal(parseEventSource(albEvent), eventTypes.applicationLoadBalancer)
    })

    it('returns states for Step Functions event', () => {
      assert.equal(parseEventSource(stepFunctionsEvent), eventTypes.stepFunctions)
    })

    it('returns cloudwatch-events for CloudWatch event', () => {
      assert.equal(parseEventSource(cloudWatchEvent), eventTypes.cloudWatchEvents)
    })

    it('returns undefined for unknown event', () => {
      assert.equal(parseEventSource({ foo: 'bar' }), undefined)
    })
  })

  describe('parseEventSourceSubType', () => {
    it('returns api-gateway-rest-api for v1 event', () => {
      assert.equal(parseEventSourceSubType(apiGatewayV1Event), eventSubTypes.apiGatewayV1)
    })

    it('returns api-gateway-http-api for v2 event', () => {
      assert.equal(parseEventSourceSubType(apiGatewayV2Event), eventSubTypes.apiGatewayV2)
    })

    it('returns unknown-sub-type for non-API Gateway event', () => {
      assert.equal(parseEventSourceSubType(sqsEvent), eventSubTypes.unknown)
    })
  })

  describe('isHTTPTriggerEvent', () => {
    it('returns true for api-gateway', () => {
      assert.equal(isHTTPTriggerEvent('api-gateway'), true)
    })

    it('returns true for application-load-balancer', () => {
      assert.equal(isHTTPTriggerEvent('application-load-balancer'), true)
    })

    it('returns true for lambda-function-url', () => {
      assert.equal(isHTTPTriggerEvent('lambda-function-url'), true)
    })

    it('returns false for sqs', () => {
      assert.equal(isHTTPTriggerEvent('sqs'), false)
    })

    it('returns false for undefined', () => {
      assert.equal(isHTTPTriggerEvent(undefined), false)
    })
  })

  describe('extractTriggerTags', () => {
    it('returns event source tag for SQS', () => {
      const tags = extractTriggerTags(sqsEvent, mockContext, 'sqs')
      assert.equal(tags['function_trigger.event_source'], 'sqs')
      assert.equal(tags['function_trigger.event_source_arn'], 'arn:aws:sqs:us-east-1:123456789012:my-queue')
    })

    it('returns HTTP tags for API Gateway v1', () => {
      const tags = extractTriggerTags(apiGatewayV1Event, mockContext, 'api-gateway')
      assert.equal(tags['function_trigger.event_source'], 'api-gateway')
      assert.equal(tags['http.method'], 'GET')
      assert.equal(tags['http.url_details.path'], '/prod/users/42')
      assert.equal(tags['http.route'], '/users/{id}')
      assert.equal(tags['http.referer'], 'https://example.com')
    })

    it('returns HTTP tags for API Gateway v2', () => {
      const tags = extractTriggerTags(apiGatewayV2Event, mockContext, 'api-gateway')
      assert.equal(tags['http.method'], 'GET')
      assert.equal(tags['http.url_details.path'], '/users/42')
      assert.equal(tags['http.route'], '/users/{id}')
    })

    it('returns HTTP tags for ALB', () => {
      const tags = extractTriggerTags(albEvent, mockContext, 'application-load-balancer')
      assert.equal(tags['http.method'], 'GET')
      assert.equal(tags['http.url_details.path'], '/health')
    })

    it('returns HTTP tags for Lambda URL', () => {
      const tags = extractTriggerTags(lambdaUrlEvent, mockContext, 'lambda-function-url')
      assert.equal(tags['http.method'], 'POST')
      assert.equal(tags['http.url_details.path'], '/submit')
    })

    it('returns empty object when eventSource is undefined', () => {
      const tags = extractTriggerTags({}, mockContext, undefined)
      assert.deepEqual(tags, {})
    })

    it('includes event_source_arn for SNS event', () => {
      const tags = extractTriggerTags(snsEvent, mockContext, 'sns')
      assert.equal(tags['function_trigger.event_source_arn'], 'arn:aws:sns:us-east-1:123456789012:my-topic')
    })

    it('includes event_source_arn for S3 event', () => {
      const tags = extractTriggerTags(s3Event, mockContext, 's3')
      assert.equal(tags['function_trigger.event_source_arn'], 'arn:aws:s3:::my-bucket')
    })

    it('includes event_source_arn for EventBridge event', () => {
      const tags = extractTriggerTags(eventBridgeEvent, mockContext, 'eventbridge')
      assert.equal(tags['function_trigger.event_source_arn'], 'my.application')
    })

    it('includes event_source_arn for Step Functions event', () => {
      const tags = extractTriggerTags(stepFunctionsEvent, mockContext, 'states')
      assert.equal(
        tags['function_trigger.event_source_arn'],
        'arn:aws:states:us-east-1:123456789012:stateMachine:my-sm'
      )
    })
  })

  describe('extractHTTPStatusCodeTag', () => {
    it('returns statusCode from result for HTTP triggers', () => {
      const triggerTags = { 'function_trigger.event_source': 'api-gateway' }
      assert.equal(extractHTTPStatusCodeTag(triggerTags, { statusCode: 201 }, false), '201')
    })

    it('returns 200 when result has no statusCode for HTTP triggers', () => {
      const triggerTags = { 'function_trigger.event_source': 'api-gateway' }
      assert.equal(extractHTTPStatusCodeTag(triggerTags, {}, false), '200')
    })

    it('returns 502 when result is undefined for non-streaming HTTP triggers', () => {
      const triggerTags = { 'function_trigger.event_source': 'api-gateway' }
      assert.equal(extractHTTPStatusCodeTag(triggerTags, undefined, false), '502')
    })

    it('returns 200 when result is undefined for streaming HTTP triggers', () => {
      const triggerTags = { 'function_trigger.event_source': 'lambda-function-url' }
      assert.equal(extractHTTPStatusCodeTag(triggerTags, undefined, true), '200')
    })

    it('returns undefined for non-HTTP triggers', () => {
      const triggerTags = { 'function_trigger.event_source': 'sqs' }
      assert.equal(extractHTTPStatusCodeTag(triggerTags, { statusCode: 200 }, false), undefined)
    })

    it('returns undefined when triggerTags is undefined', () => {
      assert.equal(extractHTTPStatusCodeTag(undefined, {}, false), undefined)
    })
  })
})
