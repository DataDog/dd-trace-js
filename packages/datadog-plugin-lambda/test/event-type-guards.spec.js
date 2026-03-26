'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
const {
  isAPIGatewayEvent,
  isAPIGatewayEventV2,
  isAPIGatewayWebsocketEvent,
  isALBEvent,
  isCloudWatchLogsEvent,
  isCloudWatchEvent,
  isCloudFrontRequestEvent,
  isDynamoDBStreamEvent,
  isKinesisStreamEvent,
  isS3Event,
  isSNSEvent,
  isSQSEvent,
  isSNSSQSEvent,
  isEBSQSEvent,
  isAppSyncResolverEvent,
  isEventBridgeEvent,
  isLambdaUrlEvent,
  isStepFunctionsEvent,
} = require('../src/event-type-guards')

// Sample events
const apiGatewayV1Event = {
  httpMethod: 'GET',
  resource: '/users',
  requestContext: { stage: 'prod', apiId: 'abc123', httpMethod: 'GET', path: '/prod/users' },
}

const apiGatewayV2Event = {
  version: '2.0',
  rawQueryString: '',
  requestContext: {
    domainName: 'abc123.execute-api.us-east-1.amazonaws.com',
    http: { method: 'GET', path: '/users' },
  },
}

const apiGatewayWebsocketEvent = {
  requestContext: { messageDirection: 'IN' },
}

const albEvent = {
  requestContext: { elb: { targetGroupArn: 'arn:aws:elasticloadbalancing:...' } },
  httpMethod: 'GET',
  path: '/health',
}

const cloudWatchLogsEvent = {
  awslogs: { data: 'base64encodeddata' },
}

const cloudWatchEvent = {
  source: 'aws.events',
  'detail-type': 'Scheduled Event',
  resources: ['arn:aws:events:us-east-1:123456:rule/my-rule'],
}

const cloudFrontEvent = {
  Records: [{ cf: { config: { distributionId: 'EXAMPLE' } } }],
}

const dynamoDBEvent = {
  Records: [{ dynamodb: { Keys: { id: { S: '1' } } }, eventSourceARN: 'arn:aws:dynamodb:...' }],
}

const kinesisEvent = {
  Records: [{ kinesis: { data: 'base64data' }, eventSourceARN: 'arn:aws:kinesis:...' }],
}

const s3Event = {
  Records: [{ s3: { bucket: { arn: 'arn:aws:s3:::my-bucket', name: 'my-bucket' }, object: { key: 'file.txt' } } }],
}

const snsEvent = {
  Records: [{ Sns: { TopicArn: 'arn:aws:sns:us-east-1:123456:my-topic', Message: 'hello' } }],
}

const sqsEvent = {
  Records: [{ eventSource: 'aws:sqs', eventSourceARN: 'arn:aws:sqs:us-east-1:123456:my-queue', body: 'test' }],
}

const snsSqsEvent = {
  Records: [{
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456:my-queue',
    body: JSON.stringify({ Type: 'Notification', TopicArn: 'arn:aws:sns:us-east-1:123456:my-topic' }),
  }],
}

const ebSqsEvent = {
  Records: [{
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456:my-queue',
    body: JSON.stringify({ 'detail-type': 'SomeEvent', source: 'my.app' }),
  }],
}

const appSyncEvent = {
  info: { selectionSetGraphQL: '{ id name }' },
}

const eventBridgeEvent = {
  'detail-type': 'MyCustomEvent',
  source: 'my.application',
  detail: { key: 'value' },
}

const lambdaUrlEvent = {
  version: '2.0',
  rawQueryString: '',
  requestContext: {
    domainName: 'abc123.lambda-url.us-east-1.on.aws',
    http: { method: 'GET', path: '/' },
  },
}

const stepFunctionsEvent = {
  Execution: { Id: 'arn:aws:states:us-east-1:123456:execution:my-state-machine:my-exec' },
  State: { Name: 'MyState' },
  StateMachine: { Id: 'arn:aws:states:us-east-1:123456:stateMachine:my-state-machine' },
}

const stepFunctionsPayloadEvent = {
  Payload: {
    Execution: { Id: 'arn:aws:states:...' },
    State: { Name: 'MyState' },
    StateMachine: { Id: 'arn:aws:states:...' },
  },
}

const stepFunctionsDatadogEvent = {
  _datadog: {
    Execution: { Id: 'arn:aws:states:...' },
    State: { Name: 'MyState' },
    StateMachine: { Id: 'arn:aws:states:...' },
  },
}

const plainEvent = { foo: 'bar' }

describe('event-type-guards', () => {
  describe('isAPIGatewayEvent', () => {
    it('returns true for API Gateway v1 event', () => {
      assert.equal(isAPIGatewayEvent(apiGatewayV1Event), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isAPIGatewayEvent(plainEvent), false)
    })

    it('returns false for API Gateway v2 event', () => {
      assert.equal(isAPIGatewayEvent(apiGatewayV2Event), false)
    })
  })

  describe('isAPIGatewayEventV2', () => {
    it('returns true for API Gateway v2 event', () => {
      assert.equal(isAPIGatewayEventV2(apiGatewayV2Event), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isAPIGatewayEventV2(plainEvent), false)
    })

    it('returns false for Lambda URL event (domainName includes lambda-url)', () => {
      assert.equal(isAPIGatewayEventV2(lambdaUrlEvent), false)
    })
  })

  describe('isAPIGatewayWebsocketEvent', () => {
    it('returns true for websocket event', () => {
      assert.equal(isAPIGatewayWebsocketEvent(apiGatewayWebsocketEvent), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isAPIGatewayWebsocketEvent(plainEvent), false)
    })
  })

  describe('isALBEvent', () => {
    it('returns true for ALB event', () => {
      assert.equal(isALBEvent(albEvent), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isALBEvent(plainEvent), false)
    })
  })

  describe('isCloudWatchLogsEvent', () => {
    it('returns true for CloudWatch Logs event', () => {
      assert.equal(isCloudWatchLogsEvent(cloudWatchLogsEvent), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isCloudWatchLogsEvent(plainEvent), false)
    })
  })

  describe('isCloudWatchEvent', () => {
    it('returns true for CloudWatch event', () => {
      assert.equal(isCloudWatchEvent(cloudWatchEvent), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isCloudWatchEvent(plainEvent), false)
    })
  })

  describe('isCloudFrontRequestEvent', () => {
    it('returns true for CloudFront event', () => {
      assert.equal(isCloudFrontRequestEvent(cloudFrontEvent), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isCloudFrontRequestEvent(plainEvent), false)
    })

    it('returns false for empty Records array', () => {
      assert.equal(isCloudFrontRequestEvent({ Records: [] }), false)
    })
  })

  describe('isDynamoDBStreamEvent', () => {
    it('returns true for DynamoDB Stream event', () => {
      assert.equal(isDynamoDBStreamEvent(dynamoDBEvent), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isDynamoDBStreamEvent(plainEvent), false)
    })
  })

  describe('isKinesisStreamEvent', () => {
    it('returns true for Kinesis event', () => {
      assert.equal(isKinesisStreamEvent(kinesisEvent), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isKinesisStreamEvent(plainEvent), false)
    })
  })

  describe('isS3Event', () => {
    it('returns true for S3 event', () => {
      assert.equal(isS3Event(s3Event), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isS3Event(plainEvent), false)
    })
  })

  describe('isSNSEvent', () => {
    it('returns true for SNS event', () => {
      assert.equal(isSNSEvent(snsEvent), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isSNSEvent(plainEvent), false)
    })
  })

  describe('isSQSEvent', () => {
    it('returns true for SQS event', () => {
      assert.equal(isSQSEvent(sqsEvent), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isSQSEvent(plainEvent), false)
    })
  })

  describe('isSNSSQSEvent', () => {
    it('returns true for SNS-via-SQS event', () => {
      assert.equal(isSNSSQSEvent(snsSqsEvent), true)
    })

    it('returns false for plain SQS event', () => {
      assert.equal(isSNSSQSEvent(sqsEvent), false)
    })

    it('returns false for a plain object', () => {
      assert.equal(isSNSSQSEvent(plainEvent), false)
    })

    it('returns false when body is not valid JSON', () => {
      const badEvent = {
        Records: [{ eventSource: 'aws:sqs', body: 'not json' }],
      }
      assert.equal(isSNSSQSEvent(badEvent), false)
    })
  })

  describe('isEBSQSEvent', () => {
    it('returns true for EventBridge-via-SQS event', () => {
      assert.equal(isEBSQSEvent(ebSqsEvent), true)
    })

    it('returns false for plain SQS event', () => {
      assert.equal(isEBSQSEvent(sqsEvent), false)
    })

    it('returns false for a plain object', () => {
      assert.equal(isEBSQSEvent(plainEvent), false)
    })

    it('returns false when body is not valid JSON', () => {
      const badEvent = {
        Records: [{ eventSource: 'aws:sqs', body: '{bad' }],
      }
      assert.equal(isEBSQSEvent(badEvent), false)
    })
  })

  describe('isAppSyncResolverEvent', () => {
    it('returns true for AppSync event', () => {
      assert.equal(isAppSyncResolverEvent(appSyncEvent), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isAppSyncResolverEvent(plainEvent), false)
    })
  })

  describe('isEventBridgeEvent', () => {
    it('returns true for EventBridge event', () => {
      assert.equal(isEventBridgeEvent(eventBridgeEvent), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isEventBridgeEvent(plainEvent), false)
    })
  })

  describe('isLambdaUrlEvent', () => {
    it('returns true for Lambda URL event', () => {
      assert.equal(isLambdaUrlEvent(lambdaUrlEvent), true)
    })

    it('returns false for API Gateway v2 event', () => {
      assert.equal(isLambdaUrlEvent(apiGatewayV2Event), false)
    })

    it('returns false for a plain object', () => {
      assert.equal(isLambdaUrlEvent(plainEvent), false)
    })
  })

  describe('isStepFunctionsEvent', () => {
    it('returns true for Step Functions event', () => {
      assert.equal(isStepFunctionsEvent(stepFunctionsEvent), true)
    })

    it('returns true when nested under Payload', () => {
      assert.equal(isStepFunctionsEvent(stepFunctionsPayloadEvent), true)
    })

    it('returns true when nested under _datadog', () => {
      assert.equal(isStepFunctionsEvent(stepFunctionsDatadogEvent), true)
    })

    it('returns false for a plain object', () => {
      assert.equal(isStepFunctionsEvent(plainEvent), false)
    })
  })

  describe('negative tests', () => {
    const guards = [
      isAPIGatewayEvent, isAPIGatewayEventV2, isAPIGatewayWebsocketEvent,
      isALBEvent, isCloudWatchLogsEvent, isCloudWatchEvent,
      isCloudFrontRequestEvent, isDynamoDBStreamEvent, isKinesisStreamEvent,
      isS3Event, isSNSEvent, isSQSEvent, isSNSSQSEvent, isEBSQSEvent,
      isAppSyncResolverEvent, isEventBridgeEvent, isLambdaUrlEvent,
      isStepFunctionsEvent,
    ]

    it('a plain object returns false for all guards', () => {
      for (const guard of guards) {
        assert.equal(guard(plainEvent), false, `${guard.name} should return false for plain object`)
      }
    })
  })
})
