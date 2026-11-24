'use strict'

// Source assertions from datadog-lambda-js span-inferrer.spec.ts at da9fc3c0.

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { parsers } = require('../../dd-trace/src/config/parsers')
const SpanInferrer = require('../src/span-inferrer')
const snssqsEvent = require('./fixtures/snssqs.json')
const snsEvent = require('./fixtures/sns.json')
const sqsEvent = require('./fixtures/sqs.json')
const ddbEvent = require('./fixtures/dynamodb.json')
const kinesisEvent = require('./fixtures/kinesis.json')
const eventBridgeEvent = require('./fixtures/eventbridge.json')
const eventBridgeSQSEvent = require('./fixtures/eventbridge-sqs.json')
const webSocketEvent = require('./fixtures/api-gateway-wss.json')
const apiGatewayV1 = require('./fixtures/api-gateway-v1.json')
const apiGatewayV2 = require('./fixtures/api-gateway-v2.json')
const apiGatewayV1Parametrized = require('./fixtures/api-gateway-v1-parametrized.json')
const apiGatewayV2Parametrized = require('./fixtures/api-gateway-v2-parametrized.json')
const apiGatewayV1RequestAuthorizer = require('./fixtures/api-gateway-traced-authorizer-request-v1.json')
const apiGatewayV1RequestAuthorizerCached = require('./fixtures/api-gateway-traced-authorizer-request-v1-cached.json')
const apiGatewayV1TokenAuthorizer = require('./fixtures/api-gateway-traced-authorizer-token-v1.json')
const apiGatewayV1TokenAuthorizerCached = require('./fixtures/api-gateway-traced-authorizer-token-v1-cached.json')
const apiGatewayV2RequestAuthorizer = require('./fixtures/api-gateway-traced-authorizer-request-v2.json')
const apiGatewayV2TokenAuthorizerCached = require('./fixtures/api-gateway-traced-authorizer-request-v2-cached.json')
const apiGatewayWSSRequestAuthorizerConnect = require(
  './fixtures/api-gateway-traced-authorizer-request-websocket-connect.json'
)
const apiGatewayWSSRequestAuthorizerMessage = require(
  './fixtures/api-gateway-traced-authorizer-request-websocket-message.json'
)
const s3Event = require('./fixtures/s3.json')
const functionUrlEvent = require('./fixtures/lambda-function-urls.json')
let inferrerConfig
function createInferrer (tracer) {
  inferrerConfig = {
    serviceMapping: parsers.MAP(process.env.DD_SERVICE_MAPPING, 'DD_SERVICE_MAPPING'),
    service: process.env.DD_SERVICE,
    serviceRepresentationEnabled: parsers.BOOLEAN(process.env.DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED ?? 'true'),
    removeIntegrationServiceNamesEnabled:
      parsers.BOOLEAN(process.env.DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED ?? 'false'),
  }
  return new SpanInferrer(tracer, inferrerConfig)
}

const mockWrapper = {
  startSpan: sinon.stub(),
}

describe('SpanInferrer', () => {
  let oldEnv

  beforeEach(() => {
    mockWrapper.startSpan.resetHistory()
    oldEnv = process.env
    process.env = {
      DD_SERVICE: 'mock-lambda-service',
    }
  })

  afterEach(() => {
    process.env = oldEnv
  })

  function getStartSpanServiceTag (callNumber) {
    const tags = mockWrapper.startSpan.getCall(callNumber - 1).args[1].tags
    // Ensure that the service.name exists in the tags
    if (!tags['service.name']) {
      throw new Error('The tag service.name is missing in the startSpan call.')
    }
    return tags['service.name']
  }

  it('initializes service mapping correctly', () => {
    process.env.DD_SERVICE_MAPPING = 'key1:value1,key2:value2'
    const inferrer = createInferrer(mockWrapper)
    assert.strictEqual(inferrer.getServiceMapping('key1'), 'value1')
    assert.strictEqual(inferrer.getServiceMapping('key2'), 'value2')
  })

  it('returns undefined when service name is not found in service mapping', () => {
    const inferrer = createInferrer(mockWrapper)
    assert.strictEqual(inferrer.getServiceMapping('non_existent_key'), undefined)
  })

  it('determines service name correctly based on specific key', () => {
    process.env.DD_SERVICE_MAPPING = 'key1:value1,key2:value2'
    const inferrer = createInferrer(mockWrapper)
    const serviceName = inferrer.determineServiceName('key1', 'key2', 'extractedKey', 'fallback')
    assert.strictEqual(serviceName, 'value1')
  })

  it('determines service name correctly based on generic key when specific key is not in service mapping', () => {
    process.env.DD_SERVICE_MAPPING = 'key1:value1,key2:value2'
    const inferrer = createInferrer(mockWrapper)
    const serviceName = inferrer.determineServiceName('non_existent_key', 'key2', 'extractedKey', 'fallback')
    assert.strictEqual(serviceName, 'value2')
  })

  it('determines service name correctly based on extracted key when no service mapping', () => {
    process.env.DD_SERVICE_MAPPING = 'key1:value1,key2:value2'
    const inferrer = createInferrer(mockWrapper)
    const serviceName = inferrer.determineServiceName(
      'non_existent_key', 'another_non_existent_key', 'extractedKey', 'fallback'
    )
    assert.strictEqual(serviceName, 'extractedKey')
  })

  it('falls back to fallback value when no service mapping is set and no extracted key is provided', () => {
    process.env.DD_SERVICE_MAPPING = 'key1:value1,key2:value2'
    const inferrer = createInferrer(mockWrapper)
    const serviceName = inferrer.determineServiceName('non_existent_key', 'another_non_existent_key', '', 'fallback')
    assert.strictEqual(serviceName, 'fallback')
  })

  describe("when DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED is set to 'true'", () => {
    beforeEach(() => {
      process.env.DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED = 'true'
    })
    it('uses instance-level service name for SNS events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(snsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'ExampleTopic')
    })
    it('uses instance-level service name for SQS events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(sqsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'MyQueue')
    })
    it('uses instance-level service name for DDB events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(ddbEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'ExampleTableWithStream')
    })
    it('uses instance-level service name for Kinesis events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(kinesisEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'EXAMPLE')
    })
    it('uses instance-level service name for EventBridge events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(eventBridgeEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'my.event')
    })
    it('uses instance-level service name for API Gateway events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(apiGatewayV1, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'id.execute-api.us-east-1.amazonaws.com')
    })
    it('uses instance-level service name for Lambda Function URL events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(functionUrlEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'a8hyhsshac.lambda-url.eu-south-1.amazonaws.com')
    })
    it('uses instance-level service name for S3 events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(s3Event, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'example-bucket')
    })
  })

  describe("when DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED is set to 'false'", () => {
    beforeEach(() => {
      process.env.DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED = 'false'
    })
    it('uses generic service name for SNS events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(snsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'sns')
    })
    it('uses generic service name for SQS events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(sqsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'sqs')
    })
    it('uses generic service name for DDB events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(ddbEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'aws.dynamodb')
    })
    it('uses generic service name for Kinesis events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(kinesisEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'kinesis')
    })
    it('uses generic service name for EventBridge events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(eventBridgeEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'eventbridge')
    })
    it('uses generic service name for API Gateway events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(apiGatewayV1, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'id.execute-api.us-east-1.amazonaws.com')
    })
    it('uses generic service name for Lambda Function URL events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(functionUrlEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'a8hyhsshac.lambda-url.eu-south-1.amazonaws.com')
    })
    it('uses generic service name for S3 events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(s3Event, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 's3')
    })
  })

  describe("when DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED is set to '0'", () => {
    beforeEach(() => {
      process.env.DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED = '0'
    })
    it('uses generic service name for SNS events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(snsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'sns')
    })
    it('uses generic service name for SQS events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(sqsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'sqs')
    })
    it('uses generic service name for DDB events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(ddbEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'aws.dynamodb')
    })
    it('uses generic service name for Kinesis events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(kinesisEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'kinesis')
    })
    it('uses generic service name for EventBridge events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(eventBridgeEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'eventbridge')
    })
    it('uses generic service name for API Gateway events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(apiGatewayV1, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'id.execute-api.us-east-1.amazonaws.com')
    })
    it('uses generic service name for Lambda Function URL events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(functionUrlEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'a8hyhsshac.lambda-url.eu-south-1.amazonaws.com')
    })
    it('uses generic service name for S3 events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(s3Event, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 's3')
    })
  })

  describe('when DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED is not set', () => {
    beforeEach(() => {
      delete process.env.DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED
    })
    it('uses instance-level service name for SNS events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(snsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'ExampleTopic')
    })
    it('uses instance-level service name for SQS events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(sqsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'MyQueue')
    })
    it('uses instance-level service name for DDB events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(ddbEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'ExampleTableWithStream')
    })
    it('uses instance-level service name for Kinesis events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(kinesisEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'EXAMPLE')
    })
    it('uses instance-level service name for EventBridge events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(eventBridgeEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'my.event')
    })
    it('uses instance-level service name for API Gateway events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(apiGatewayV1, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'id.execute-api.us-east-1.amazonaws.com')
    })
    it('uses instance-level service name for Lambda Function URL events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(functionUrlEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'a8hyhsshac.lambda-url.eu-south-1.amazonaws.com')
    })
    it('uses instance-level service name for S3 events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(s3Event, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'example-bucket')
    })
  })

  describe("when DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED is set to 'true'", () => {
    beforeEach(() => {
      process.env.DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED = 'true'
    })
    it('uses DD_SERVICE for SNS events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(snsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'mock-lambda-service')
    })
    it('uses DD_SERVICE for SQS events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(sqsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'mock-lambda-service')
    })
    it('uses DD_SERVICE for DDB events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(ddbEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'mock-lambda-service')
    })
    it('uses DD_SERVICE for Kinesis events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(kinesisEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'mock-lambda-service')
    })
    it('uses DD_SERVICE for EventBridge events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(eventBridgeEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'mock-lambda-service')
    })
    it('uses DD_SERVICE for API Gateway events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(apiGatewayV1, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'mock-lambda-service')
    })
    it('uses DD_SERVICE for Lambda Function URL events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(functionUrlEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'mock-lambda-service')
    })
    it('uses DD_SERVICE for S3 events', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(s3Event, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'mock-lambda-service')
    })
    it('lets an explicit DD_SERVICE_MAPPING entry win over DD_SERVICE', () => {
      process.env.DD_SERVICE_MAPPING = 'lambda_sqs:remapped-queue-service'
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(sqsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'remapped-queue-service')
    })
    it('falls back to the AWS resource name when DD_SERVICE is unset', () => {
      delete process.env.DD_SERVICE
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(sqsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'MyQueue')
    })
    it('takes precedence over DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED=false', () => {
      process.env.DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED = 'false'
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(sqsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'mock-lambda-service')
    })
  })

  describe('when DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED is not set', () => {
    it('leaves the AWS resource name in place', () => {
      const inferrer = createInferrer(mockWrapper)
      inferrer.createInferredSpan(sqsEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'MyQueue')
    })
  })

  it('extracts service name from event when service mapping has incorrect delimiters', () => {
    process.env.DD_SERVICE_MAPPING = 'key1-value1,key2=value2'
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(snsEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'ExampleTopic')
  })

  it('extracts service name from event when service mapping has no value for a key', () => {
    process.env.DD_SERVICE_MAPPING = 'key1:value1,key2:'
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(snsEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'ExampleTopic')
  })

  it('extracts service name from event when service mapping has no key', () => {
    process.env.DD_SERVICE_MAPPING = 'key1:value1,:value2'
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(snsEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'ExampleTopic')
  })

  it('extracts service name from event when service mapping is not set', () => {
    delete process.env.DD_SERVICE_MAPPING
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(snsEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'ExampleTopic')
  })

  it('handles mappings without a value', () => {
    process.env.DD_SERVICE_MAPPING = 'key1:value1,key2:'
    const inferrer = createInferrer(mockWrapper)
    assert.strictEqual(inferrer.getServiceMapping('key1'), 'value1')
    assert.strictEqual(inferrer.getServiceMapping('key2'), undefined)
  })

  it('ignores mappings without a key', () => {
    process.env.DD_SERVICE_MAPPING = 'key1:value1,:value2'
    const inferrer = createInferrer(mockWrapper)
    assert.strictEqual(inferrer.getServiceMapping(''), undefined)
  })

  it('returns undefined for mappings with incorrect delimiters', () => {
    process.env.DD_SERVICE_MAPPING = 'key1-value1,key2=value2'
    const inferrer = createInferrer(mockWrapper)
    assert.strictEqual(inferrer.getServiceMapping('key1'), undefined)
    assert.strictEqual(inferrer.getServiceMapping('key2'), undefined)
  })

  it('handles mappings with additional whitespace', () => {
    process.env.DD_SERVICE_MAPPING = 'key1 : value1 , key2 : value2'
    const inferrer = createInferrer(mockWrapper)
    assert.strictEqual(inferrer.getServiceMapping('key1'), 'value1')
    assert.strictEqual(inferrer.getServiceMapping('key2'), 'value2')
  })

  it('returns undefined when service mapping is not set', () => {
    delete process.env.DD_SERVICE_MAPPING
    const inferrer = createInferrer(mockWrapper)
    assert.strictEqual(inferrer.getServiceMapping('key1'), undefined)
  })

  it('ignores mappings with the same key and value', () => {
    process.env.DD_SERVICE_MAPPING = 'key1:key1'
    const inferrer = createInferrer(mockWrapper)
    assert.strictEqual(inferrer.getServiceMapping('key1'), undefined)
  })

  it('ignores mappings with more than one colon', () => {
    process.env.DD_SERVICE_MAPPING = 'key1:value1:value2'
    const inferrer = createInferrer(mockWrapper)
    assert.strictEqual(inferrer.getServiceMapping('key1'), undefined)
  })

  it('remaps all SNS inferred span service name based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { lambda_sns: 'new-name' }
    inferrer.createInferredSpan(snsEvent, {}, {})
    const modifiedSnsEvent = JSON.parse(JSON.stringify(snsEvent))
    modifiedSnsEvent.Records[0].EventSubscriptionArn = 'arn:aws:sns:us-east-1:123456789012:DifferentTopic'
    inferrer.createInferredSpan(modifiedSnsEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'new-name')
  })

  it('remaps specific SNS inferred span service name based on DD_SERVICE_MAPPING topicname', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { DifferentTopic: 'new-name' }
    inferrer.createInferredSpan(snsEvent, {}, {})
    const modifiedSnsEvent = JSON.parse(JSON.stringify(snsEvent))
    modifiedSnsEvent.Records[0].Sns.TopicArn = 'arn:aws:sns:us-east-1:123456789012:DifferentTopic'
    inferrer.createInferredSpan(modifiedSnsEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'ExampleTopic')
    assert.strictEqual(getStartSpanServiceTag(2), 'new-name')
  })

  it('remaps all SQS inferred span service name based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { lambda_sqs: 'new-name' }
    inferrer.createInferredSpan(sqsEvent, {}, {})
    const modifiedSqsEvent = JSON.parse(JSON.stringify(sqsEvent))
    modifiedSqsEvent.Records[0].eventSourceARN = 'arn:aws:sqs:us-east-1:123456789012:DifferentQueue'
    inferrer.createInferredSpan(modifiedSqsEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'new-name')
  })

  it('remaps specific SQS inferred span service name based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { MyQueue: 'new-name' }
    inferrer.createInferredSpan(sqsEvent, {}, {})
    const modifiedDdbEvent = JSON.parse(JSON.stringify(sqsEvent))
    modifiedDdbEvent.Records[0].eventSourceARN = 'arn:aws:sqs:us-east-1:123456789012:DifferentQueue'
    inferrer.createInferredSpan(modifiedDdbEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'DifferentQueue')
  })

  it('remaps all ddb inferred span service name based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { lambda_dynamodb: 'new-name' }
    inferrer.createInferredSpan(ddbEvent, {}, {})
    const modifiedDdbEvent = JSON.parse(JSON.stringify(ddbEvent))
    modifiedDdbEvent.Records[0].eventSourceARN =
            'arn:aws:dynamodb:us-east-1:123456789012:table/DifferentTableWithStream/stream/2015-06-27T00:48:05.899'
    inferrer.createInferredSpan(modifiedDdbEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'new-name')
  })

  it('remaps specific ddb inferred span service name based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { ExampleTableWithStream: 'new-name' }
    inferrer.createInferredSpan(ddbEvent, {}, {})
    const modifiedDdbEvent = JSON.parse(JSON.stringify(ddbEvent))
    modifiedDdbEvent.Records[0].eventSourceARN =
            'arn:aws:dynamodb:us-east-1:123456789012:table/DifferentTableWithStream/stream/2015-06-27T00:48:05.899'
    inferrer.createInferredSpan(modifiedDdbEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'DifferentTableWithStream')
  })

  it('remaps all kinesis inferred span service name based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { lambda_kinesis: 'new-name' }
    inferrer.createInferredSpan(kinesisEvent, {}, {})
    const modifiedKinesisEvent = JSON.parse(JSON.stringify(kinesisEvent))
    modifiedKinesisEvent.Records[0].eventSourceARN = 'arn:aws:kinesis:DIFFERENT_EXAMPLE'
    inferrer.createInferredSpan(modifiedKinesisEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'new-name')
  })

  it('remaps specific kinesis inferred span service name based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { EXAMPLE: 'new-name' }
    inferrer.createInferredSpan(kinesisEvent, {}, {})
    const modifiedKinesisEvent = JSON.parse(JSON.stringify(kinesisEvent))
    modifiedKinesisEvent.Records[0].eventSourceARN = 'arn:aws:kinesis:DIFFERENT_EXAMPLE'
    inferrer.createInferredSpan(modifiedKinesisEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'DIFFERENT_EXAMPLE')
  })

  it('remaps sns sqs inferred spans service names based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { lambda_sns: 'new-sns-name', lambda_sqs: 'new-sqs-name' }
    inferrer.createInferredSpan(snssqsEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-sns-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'new-sqs-name')
  })

  it('remaps all eventbridge inferred span service name based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { lambda_eventbridge: 'new-name' }
    inferrer.createInferredSpan(eventBridgeEvent, {}, {})
    const modifiedDdbEvent = JSON.parse(JSON.stringify(eventBridgeEvent))
    modifiedDdbEvent.source = 'my.different.event'
    inferrer.createInferredSpan(modifiedDdbEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'new-name')
  })

  it('remaps specific eventbridge inferred span service name based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { 'my.event': 'new-name' }
    inferrer.createInferredSpan(eventBridgeEvent, {}, {})
    const modifiedDdbEvent = JSON.parse(JSON.stringify(eventBridgeEvent))
    modifiedDdbEvent.source = 'my.different.event'
    inferrer.createInferredSpan(modifiedDdbEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'my.different.event')
  })

  it('remaps all API Gateway inferred span service names based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { lambda_api_gateway: 'new-name' }
    inferrer.createInferredSpan(webSocketEvent, {}, {})
    inferrer.createInferredSpan(apiGatewayV2, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'new-name')
  })

  it(
    'remaps specific API Gateway inferred span service names based on DD_SERVICE_MAPPING and leaves others alone',
    () => {
      const inferrer = createInferrer(mockWrapper)
      inferrerConfig.serviceMapping = { '08se3mvh28': 'new-name' }
      inferrer.createInferredSpan(webSocketEvent, {}, {})
      inferrer.createInferredSpan(apiGatewayV2, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
      assert.strictEqual(getStartSpanServiceTag(2), 'r3pmxmplak.execute-api.us-east-2.amazonaws.com')
    })

  it('remaps all Lambda URL inferred span service name based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { lambda_url: 'new-name' }
    inferrer.createInferredSpan(functionUrlEvent, {}, {})
    const modifiedFunctionUrlEvent = JSON.parse(JSON.stringify(functionUrlEvent))
    modifiedFunctionUrlEvent.requestContext.domainName = 'foobar.lambda-url.eu-south-1.amazonaws.com'
    inferrer.createInferredSpan(modifiedFunctionUrlEvent, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'new-name')
  })

  it(
    'remaps specific Lambda URL inferred span service name based on DD_SERVICE_MAPPING and leaves others alone',
    () => {
      const inferrer = createInferrer(mockWrapper)
      inferrerConfig.serviceMapping = { a8hyhsshac: 'new-name' }
      inferrer.createInferredSpan(functionUrlEvent, {}, {})
      const modifiedFunctionUrlEvent = JSON.parse(JSON.stringify(functionUrlEvent))
      modifiedFunctionUrlEvent.requestContext.apiId = 'different'
      inferrer.createInferredSpan(modifiedFunctionUrlEvent, {}, {})
      assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
      assert.strictEqual(getStartSpanServiceTag(2), 'a8hyhsshac.lambda-url.eu-south-1.amazonaws.com')
    })

  it('remaps all S3 inferred span service name based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { lambda_s3: 'new-name' }
    inferrer.createInferredSpan(s3Event, {}, {})
    const modifiedS3Event = JSON.parse(JSON.stringify(s3Event))
    modifiedS3Event.Records[0].s3.bucket.arn = 'arn:aws:s3:::different-example-bucket'
    modifiedS3Event.Records[0].s3.bucket.name = 'different-example-bucket'
    inferrer.createInferredSpan(modifiedS3Event, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'new-name')
  })

  it('remaps specific S3 inferred span service name based on DD_SERVICE_MAPPING', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrerConfig.serviceMapping = { 'example-bucket': 'new-name' }
    inferrer.createInferredSpan(s3Event, {}, {})
    const modifiedS3Event = JSON.parse(JSON.stringify(s3Event))
    modifiedS3Event.Records[0].s3.bucket.arn = 'arn:aws:s3:::different-example-bucket'
    modifiedS3Event.Records[0].s3.bucket.name = 'different-example-bucket'
    inferrer.createInferredSpan(modifiedS3Event, {}, {})
    assert.strictEqual(getStartSpanServiceTag(1), 'new-name')
    assert.strictEqual(getStartSpanServiceTag(2), 'different-example-bucket')
  })

  it('creates an inferred span for sns events', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(snsEvent, {}, {})
    sinon.assert.calledWithExactly(mockWrapper.startSpan, 'aws.sns', {
      childOf: {},
      startTime: 1643039127968,
      tags: {
        _inferred_span: { synchronicity: 'async', tag_source: 'self' },
        event_subscription_arn: 'arn:aws:sns:us-east-1:123456789012:ExampleTopic',
        message_id: '95df01b4-ee98-5cb9-9903-4c221d41eb5e',
        operation_name: 'aws.sns',
        'peer.service': 'mock-lambda-service',
        request_id: undefined,
        'resource.name': 'ExampleTopic',
        resource_names: 'ExampleTopic',
        service: 'ExampleTopic',
        'service.name': 'ExampleTopic',
        'span.kind': 'server',
        'span.type': 'sns',
        subject: 'example subject',
        topic_arn: 'arn:aws:sns:us-east-1:123456789012:ExampleTopic',
        topicname: 'ExampleTopic',
        type: 'Notification',
      },
    })
  })

  it('creates an inferred span for sqs events', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(sqsEvent, {}, {})
    sinon.assert.calledWithExactly(mockWrapper.startSpan, 'aws.sqs', {
      childOf: {},
      startTime: 1523232000000,
      tags: {
        _inferred_span: { synchronicity: 'async', tag_source: 'self' },
        event_source_arn: 'arn:aws:sqs:us-east-1:123456789012:MyQueue',
        operation_name: 'aws.sqs',
        'peer.service': 'mock-lambda-service',
        queuename: 'MyQueue',
        receipt_handle: 'MessageReceiptHandle',
        request_id: undefined,
        'resource.name': 'MyQueue',
        resource_names: 'MyQueue',
        retry_count: 1,
        sender_id: '123456789012',
        service: 'MyQueue',
        'service.name': 'MyQueue',
        'span.kind': 'server',
        'span.type': 'web',
      },
    })
  })

  it('creates an inferred span for ddb events', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(ddbEvent, {}, {})
    sinon.assert.calledWithExactly(mockWrapper.startSpan, 'aws.dynamodb', {
      childOf: {},
      startTime: 1428537600000,
      tags: {
        _inferred_span: { synchronicity: 'async', tag_source: 'self' },
        tablename: 'ExampleTableWithStream',
        event_id: 'c4ca4238a0b923820dcc509a6f75849b',
        event_name: 'INSERT',
        event_source_arn:
          'arn:aws:dynamodb:us-east-1:123456789012:table/ExampleTableWithStream/stream/2015-06-27T00:48:05.899',
        event_version: '1.1',
        operation_name: 'aws.dynamodb',
        'peer.service': 'mock-lambda-service',
        request_id: undefined,
        'resource.name': 'INSERT ExampleTableWithStream',
        resource_names: 'INSERT ExampleTableWithStream',
        service: 'ExampleTableWithStream',
        'service.name': 'ExampleTableWithStream',
        size_bytes: 26,
        'span.kind': 'server',
        'span.type': 'web',
        stream_view_type: 'NEW_AND_OLD_IMAGES',
      },
    })
  })

  it('creates an inferred span for kinesis events', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(kinesisEvent, {}, {})
    sinon.assert.calledWithExactly(mockWrapper.startSpan, 'aws.kinesis', {
      childOf: {},
      startTime: 1642518727248,
      tags: {
        _inferred_span: { synchronicity: 'async', tag_source: 'self' },
        event_id: 'shardId-000000000000:49545115243490985018280067714973144582180062593244200961',
        event_name: 'aws:kinesis:record',
        event_source_arn: 'arn:aws:kinesis:EXAMPLE',
        event_version: '1.0',
        operation_name: 'aws.kinesis',
        'peer.service': 'mock-lambda-service',
        partition_key: 'cdbfd750-cec0-4f0f-a4b0-82ae6152c7fb',
        request_id: undefined,
        'resource.name': 'EXAMPLE',
        resource_names: 'EXAMPLE',
        service: 'EXAMPLE',
        'service.name': 'EXAMPLE',
        shardid: '49545115243490985018280067714973144582180062593244200961',
        'span.kind': 'server',
        'span.type': 'web',
        streamname: 'EXAMPLE',
      },
    })
  })

  it('creates an inferred span for sns sqs events', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(snssqsEvent, {}, {})
    assert.deepStrictEqual(mockWrapper.startSpan.args, [
      [
        'aws.sns',
        {
          childOf: {},
          startTime: 1639777618040,
          tags: {
            _inferred_span: { synchronicity: 'async', tag_source: 'self' },
            message_id: '0a0ab23e-4861-5447-82b7-e8094ff3e332',
            operation_name: 'aws.sns',
            'peer.service': 'mock-lambda-service',
            request_id: undefined,
            'resource.name': 'js-library-test-dev-demoTopic-15WGUVRCBMPAA',
            resource_names: 'js-library-test-dev-demoTopic-15WGUVRCBMPAA',
            service: 'js-library-test-dev-demoTopic-15WGUVRCBMPAA',
            'service.name': 'js-library-test-dev-demoTopic-15WGUVRCBMPAA',
            'span.kind': 'server',
            'span.type': 'sns',
            subject: undefined,
            topic_arn: 'arn:aws:sns:eu-west-1:601427279990:js-library-test-dev-demoTopic-15WGUVRCBMPAA',
            topicname: 'js-library-test-dev-demoTopic-15WGUVRCBMPAA',
            type: 'Notification',
          },
        },
      ],
      [
        'aws.sqs',
        {
          childOf: undefined,
          startTime: 1639777618130,
          tags: {
            _inferred_span: { synchronicity: 'async', tag_source: 'self' },
            event_source_arn: 'arn:aws:sqs:eu-west-1:601427279990:aj-js-library-test-dev-demo-queue',
            operation_name: 'aws.sqs',
            'peer.service': 'mock-lambda-service',
            queuename: 'aj-js-library-test-dev-demo-queue',
            receipt_handle:
              'AQEBER6aRkfG8092GvkL7FRwCwbQ7LLDW9Tlk/CembqHe+suS2kfFxXiukomvaIN61QoyQMoRgWuV52SDkiQno2u+5hP64B' +
              'Dbmw+e/KR9ayvIfHJ3M6RfyQLaWNWm3hDFBCKTnBMVIxtdx0N9epZZewyokjKcrNYtmCghFgTCvZzsQkowi5rnoHAVHJ3je' +
              '1c3bDnQ1KLrZFgajDnootYXDwEPuMq5FIxrf4EzTe0S7S+rnRm+GaQfeBLBVAY6dASL9usV3/AFRqDtaI7GKI+0F2NCgLlq' +
              'j49VlPRz4ldhkGknYlKTZTluAqALWLJS62/J1GQo53Cs3nneJcmu5ajB2zzmhhRXoXINEkLhCD5ujZfcsw9H4xqW69Or4EC' +
              'vlqx14bUU2rtMIW0QM2p7pEeXnyocymQv6m1te113eYWTVmaJ4I=',
            request_id: undefined,
            'resource.name': 'aj-js-library-test-dev-demo-queue',
            resource_names: 'aj-js-library-test-dev-demo-queue',
            retry_count: 1,
            sender_id: 'AIDAIOA2GYWSHW4E2VXIO',
            service: 'aj-js-library-test-dev-demo-queue',
            'service.name': 'aj-js-library-test-dev-demo-queue',
            'span.kind': 'server',
            'span.type': 'web',
          },
        },
      ],
    ])
  })

  it('creates an inferred span for eventbridge events', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(eventBridgeEvent, {}, {})
    sinon.assert.calledWithExactly(mockWrapper.startSpan, 'aws.eventbridge', {
      childOf: {},
      startTime: 1643040010000,
      tags: {
        _inferred_span: { synchronicity: 'async', tag_source: 'self' },
        operation_name: 'aws.eventbridge',
        'peer.service': 'mock-lambda-service',
        request_id: undefined,
        'resource.name': 'my.event',
        resource_names: 'my.event',
        service: 'my.event',
        'service.name': 'my.event',
        'span.kind': 'server',
        'span.type': 'web',
      },
    })
  })

  it('creates an inferred span for eventbridge sqs events', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(eventBridgeSQSEvent, {}, {})
    assert.deepStrictEqual(mockWrapper.startSpan.args, [
      [
        'aws.eventbridge',
        {
          childOf: {},
          startTime: 1691102943000,
          tags: {
            _inferred_span: { synchronicity: 'async', tag_source: 'self' },
            operation_name: 'aws.eventbridge',
            'peer.service': 'mock-lambda-service',
            request_id: undefined,
            'resource.name': 'my.Source',
            resource_names: 'my.Source',
            service: 'my.Source',
            'service.name': 'my.Source',
            'span.kind': 'server',
            'span.type': 'web',
          },
        },
      ],
      [
        'aws.sqs',
        {
          childOf: undefined,
          startTime: 1691102943638,
          tags: {
            _inferred_span: { synchronicity: 'async', tag_source: 'self' },
            event_source_arn: 'arn:aws:sqs:us-east-1:425362996713:lambda-eb-sqs-lambda-dev-demo-queue',
            operation_name: 'aws.sqs',
            'peer.service': 'mock-lambda-service',
            queuename: 'lambda-eb-sqs-lambda-dev-demo-queue',
            receipt_handle:
              'AQEB4mIfRcyqtzn1X5Ss+ConhTejVGc+qnAcmu3/Z9ZvbNkaPcpuDLX/bzvPD/ZkAXJUXZcemGSJmd7L3snZHKMP2Ck8run' +
              'Ziyl4mubiLb444pZvdiNPuGRJ6a3FvgS/GQPzho/9nNMyOi66m8Viwh70v4EUCPGO4JmD3TTDAUrrcAnqU4WSObjfC/NAp9' +
              'bI6wH2CEyAYEfex6Nxplbl/jBf9ZUG0I3m3vQd0Q4l4gd4jIR4oxQUglU2Tldl4Kx5fMUAhTRLAENri6HsY81avBkKd9FAu' +
              'xONlsITB5uj02kOkvLlRGEcalqsKyPJ7AFaDLrOLaL3U+yReroPEJ5R5nwhLOEbeN5HROlZRXeaAwZOIN8BjqdeooYTIOrt' +
              'vMEVb7a6OPLMdH1XB+ddevtKAH8K9Tm2ZjpaA7dtBGh1zFVHzBk=',
            request_id: undefined,
            'resource.name': 'lambda-eb-sqs-lambda-dev-demo-queue',
            resource_names: 'lambda-eb-sqs-lambda-dev-demo-queue',
            retry_count: 1,
            sender_id: 'AIDAJXNJGGKNS7OSV23OI',
            service: 'lambda-eb-sqs-lambda-dev-demo-queue',
            'service.name': 'lambda-eb-sqs-lambda-dev-demo-queue',
            'span.kind': 'server',
            'span.type': 'web',
          },
        },
      ],
    ])
  })

  it('creates an inferred span for websocket events', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(webSocketEvent, {}, {})
    sinon.assert.calledWithExactly(mockWrapper.startSpan, 'aws.apigateway', {
      childOf: {},
      startTime: 1642607783913,
      tags: {
        _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
        apiid: '08se3mvh28',
        connection_id: 'MM0qReAFGjQCE-w=',
        endpoint: '$connect',
        event_type: 'CONNECT',
        'http.url': 'https://08se3mvh28.execute-api.eu-west-1.amazonaws.com$connect',
        message_direction: 'IN',
        'peer.service': 'mock-lambda-service',
        request_id: undefined,
        'resource.name': '08se3mvh28.execute-api.eu-west-1.amazonaws.com $connect',
        resource_names: '08se3mvh28.execute-api.eu-west-1.amazonaws.com $connect',
        service: '08se3mvh28.execute-api.eu-west-1.amazonaws.com',
        'service.name': '08se3mvh28.execute-api.eu-west-1.amazonaws.com',
        'span.kind': 'server',
        'span.type': 'web',
      },
    })
  })

  it('creates an inferred span for API Gateway V1 events', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(apiGatewayV1, {}, {})
    sinon.assert.calledWithExactly(mockWrapper.startSpan, 'aws.apigateway', {
      childOf: {},
      startTime: 1583349317135,
      tags: {
        _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
        apiid: 'id',
        endpoint: '/my/path',
        'http.url': 'https://id.execute-api.us-east-1.amazonaws.com/my/path',
        domain_name: 'id.execute-api.us-east-1.amazonaws.com',
        'peer.service': 'mock-lambda-service',
        request_id: undefined,
        'http.method': 'GET',
        'resource.name': 'GET /path',
        resource_names: 'GET /path',
        service: 'id.execute-api.us-east-1.amazonaws.com',
        'service.name': 'id.execute-api.us-east-1.amazonaws.com',
        'span.kind': 'server',
        'span.type': 'web',
        stage: '$default',
      },
    })
  })

  it('creates an inferred span for API Gateway V2 events', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(apiGatewayV2, {}, {})
    sinon.assert.calledWithExactly(mockWrapper.startSpan, 'aws.httpapi', {
      childOf: {},
      startTime: 1583817383220,
      tags: {
        _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
        apiid: 'r3pmxmplak',
        endpoint: '/default/nodejs-apig-function-1G3XMPLZXVXYI',
        'http.url': 'https://r3pmxmplak.execute-api.us-east-2.amazonaws.com/default/nodejs-apig-function-1G3XMPLZXVXYI',
        domain_name: 'r3pmxmplak.execute-api.us-east-2.amazonaws.com',
        'peer.service': 'mock-lambda-service',
        request_id: undefined,
        'http.method': 'GET',
        'resource.name': 'GET /default/nodejs-apig-function-1G3XMPLZXVXYI',
        resource_names: 'GET /default/nodejs-apig-function-1G3XMPLZXVXYI',
        service: 'r3pmxmplak.execute-api.us-east-2.amazonaws.com',
        'service.name': 'r3pmxmplak.execute-api.us-east-2.amazonaws.com',
        'span.kind': 'server',
        'span.type': 'web',
        stage: 'default',
      },
    })
  })

  it('creates an inferred span for API Gateway V1 events with parameters', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(apiGatewayV1Parametrized, {}, {})
    sinon.assert.calledWithExactly(mockWrapper.startSpan, 'aws.apigateway', {
      childOf: {},
      startTime: 1710529824520,
      tags: {
        _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
        apiid: 'mcwkra0ya4',
        endpoint: '/dev/user/42',
        'http.url': 'https://mcwkra0ya4.execute-api.sa-east-1.amazonaws.com/dev/user/42',
        domain_name: 'mcwkra0ya4.execute-api.sa-east-1.amazonaws.com',
        'peer.service': 'mock-lambda-service',
        request_id: undefined,
        'http.method': 'GET',
        'resource.name': 'GET /user/{id}',
        resource_names: 'GET /user/{id}',
        service: 'mcwkra0ya4.execute-api.sa-east-1.amazonaws.com',
        'service.name': 'mcwkra0ya4.execute-api.sa-east-1.amazonaws.com',
        'span.kind': 'server',
        'span.type': 'web',
        stage: 'dev',
      },
    })
  })

  it('creates an inferred span for API Gateway V2 events with parameters', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(apiGatewayV2Parametrized, {}, {})
    sinon.assert.calledWithExactly(mockWrapper.startSpan, 'aws.httpapi', {
      childOf: {},
      startTime: 1710529905066,
      tags: {
        _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
        apiid: '9vj54we5ih',
        endpoint: '/user/42',
        'http.url': 'https://9vj54we5ih.execute-api.sa-east-1.amazonaws.com/user/42',
        domain_name: '9vj54we5ih.execute-api.sa-east-1.amazonaws.com',
        'peer.service': 'mock-lambda-service',
        request_id: undefined,
        'http.method': 'GET',
        'resource.name': 'GET /user/{id}',
        resource_names: 'GET /user/{id}',
        service: '9vj54we5ih.execute-api.sa-east-1.amazonaws.com',
        'service.name': '9vj54we5ih.execute-api.sa-east-1.amazonaws.com',
        'span.kind': 'server',
        'span.type': 'web',
        stage: '$default',
      },
    })
  })

  it('sets dd_resource_key with restapis ARN for API Gateway V1 events', () => {
    const inferrer = createInferrer(mockWrapper)
    const mockContext = {
      invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function',
    }
    inferrer.createInferredSpan(apiGatewayV1, mockContext, {})
    const callArgs = mockWrapper.startSpan.getCall(0).args
    assert.strictEqual(callArgs[1].tags.dd_resource_key, 'arn:aws:apigateway:us-east-1::/restapis/id')
  })

  it('sets dd_resource_key with apis ARN for API Gateway V2 events', () => {
    const inferrer = createInferrer(mockWrapper)
    const mockContext = {
      invokedFunctionArn: 'arn:aws:lambda:us-east-2:123456789012:function:my-function',
    }
    inferrer.createInferredSpan(apiGatewayV2, mockContext, {})
    const callArgs = mockWrapper.startSpan.getCall(0).args
    assert.strictEqual(callArgs[1].tags.dd_resource_key, 'arn:aws:apigateway:us-east-2::/apis/r3pmxmplak')
  })

  it('sets dd_resource_key with restapis ARN for WebSocket events', () => {
    const inferrer = createInferrer(mockWrapper)
    const mockContext = {
      invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function',
    }
    inferrer.createInferredSpan(webSocketEvent, mockContext, {})
    const callArgs = mockWrapper.startSpan.getCall(0).args
    assert.strictEqual(callArgs[1].tags.dd_resource_key, 'arn:aws:apigateway:us-east-1::/restapis/08se3mvh28')
  })

  it('does not set dd_resource_key when context is missing invokedFunctionArn', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(apiGatewayV1, {}, {})
    const callArgs = mockWrapper.startSpan.getCall(0).args
    assert.strictEqual(callArgs[1].tags.dd_resource_key, undefined)
  })

  it('creates an inferred span for Lambda Function URL Events', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(functionUrlEvent, {}, {})
    sinon.assert.calledWithExactly(mockWrapper.startSpan, 'aws.lambda.url', {
      childOf: {},
      startTime: 1637169449721,
      tags: {
        _inferred_span: {
          synchronicity: 'sync',
          tag_source: 'self',
        },
        endpoint: '/',
        'http.method': 'GET',
        'http.url': 'https://a8hyhsshac.lambda-url.eu-south-1.amazonaws.com/',
        operation_name: 'aws.lambda.url',
        'peer.service': 'mock-lambda-service',
        request_id: undefined,
        'resource.name': 'GET /',
        resource_names: 'GET /',
        service: 'a8hyhsshac.lambda-url.eu-south-1.amazonaws.com',
        'service.name': 'a8hyhsshac.lambda-url.eu-south-1.amazonaws.com',
        'span.kind': 'server',
        'span.type': 'http',
      },
    })
  })

  it('creates an inferred span for s3 events', () => {
    const inferrer = createInferrer(mockWrapper)
    inferrer.createInferredSpan(s3Event, {}, {})
    sinon.assert.calledWithExactly(mockWrapper.startSpan, 'aws.s3', {
      childOf: {},
      startTime: 0,
      tags: {
        _inferred_span: { synchronicity: 'async', tag_source: 'self' },
        bucket_arn: 'arn:aws:s3:::example-bucket',
        bucketname: 'example-bucket',
        event_name: 'ObjectCreated:Put',
        object_etag: '0123456789abcdef0123456789abcdef',
        object_key: 'test/key',
        object_size: 1024,
        operation_name: 'aws.s3',
        'peer.service': 'mock-lambda-service',
        request_id: undefined,
        'resource.name': 'example-bucket',
        resource_names: 'example-bucket',
        service: 'example-bucket',
        'service.name': 'example-bucket',
        'span.kind': 'server',
        'span.type': 'web',
      },
    })
  })
})
const mockFinish = () => undefined
describe('API Gateway resource fallback', () => {
  for (const input of [apiGatewayV1, apiGatewayV2]) {
    it(`keeps an absent resource empty for API Gateway ${input.version}`, () => {
      const trigger = structuredClone(input)
      delete trigger.rawPath
      delete trigger.requestContext.resourcePath
      delete trigger.requestContext.routeKey
      const startSpan = sinon.stub()
      new SpanInferrer({ startSpan }, { serviceMapping: {} }).createInferredSpan(trigger, {}, {})
      assert.strictEqual(startSpan.firstCall.args[1].tags['resource.name'], 'GET ')
    })
  }
})

describe('Authorizer Spans', () => {
  const mockWrapperWithFinish = {
    startSpan: sinon.stub().callsFake(() => {
      return {
        finish: mockFinish,
      }
    }),
  }
  let oldEnv

  beforeEach(() => {
    mockWrapperWithFinish.startSpan = sinon.stub().callsFake(() => {
      return {
        finish: mockFinish,
      }
    })
    oldEnv = process.env
    process.env = {
      DD_SERVICE: 'mock-lambda-service',
    }
  })

  afterEach(() => {
    mockWrapperWithFinish.startSpan.reset()
    process.env = oldEnv
  })

  it('creates an inferred span for API Gateway V1 event with traced authorizers [Request Type]', () => {
    const inferrer = createInferrer(mockWrapperWithFinish)
    inferrer.createInferredSpan(apiGatewayV1RequestAuthorizer, {}, {})
    assert.deepStrictEqual(mockWrapperWithFinish.startSpan.getCall(0).args, [
      'aws.apigateway.authorizer',
      {
        childOf: {},
        startTime: 1660939857052,
        tags: {
          _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
          apiid: '3gsxz7lha4',
          domain_name: '3gsxz7lha4.execute-api.eu-west-1.amazonaws.com',
          endpoint: '/dev/hello',
          'http.method': 'POST',
          'http.url': 'https://3gsxz7lha4.execute-api.eu-west-1.amazonaws.com/dev/hello',
          'peer.service': 'mock-lambda-service',
          request_id: undefined,
          'resource.name': 'POST /hello',
          resource_names: 'POST /hello',
          service: '3gsxz7lha4.execute-api.eu-west-1.amazonaws.com',
          'service.name': '3gsxz7lha4.execute-api.eu-west-1.amazonaws.com',
          'span.kind': 'server',
          'span.type': 'web',
          stage: 'dev',
        },
      },
    ])
    assert.deepStrictEqual(mockWrapperWithFinish.startSpan.getCall(1).args, [
      'aws.apigateway',
      {
        childOf: { finish: mockFinish }, // Hack around jest mocks
        startTime: 1660939857075,
        tags: {
          _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
          apiid: '3gsxz7lha4',
          domain_name: '3gsxz7lha4.execute-api.eu-west-1.amazonaws.com',
          endpoint: '/dev/hello',
          'http.method': 'POST',
          'http.url': 'https://3gsxz7lha4.execute-api.eu-west-1.amazonaws.com/dev/hello',
          'peer.service': 'mock-lambda-service',
          request_id: undefined,
          'resource.name': 'POST /hello',
          resource_names: 'POST /hello',
          service: '3gsxz7lha4.execute-api.eu-west-1.amazonaws.com',
          'service.name': '3gsxz7lha4.execute-api.eu-west-1.amazonaws.com',
          'span.kind': 'server',
          'span.type': 'web',
          stage: 'dev',
        },
      },
    ])
  })

  it('No inferred span for API Gateway V1 event with CACHED authorizers [Request Type]', () => {
    const inferrer = createInferrer(mockWrapperWithFinish)
    inferrer.createInferredSpan(apiGatewayV1RequestAuthorizerCached, {}, {})
    assert.deepStrictEqual(mockWrapperWithFinish.startSpan.getCall(0).args, [
      'aws.apigateway',
      {
        childOf: {}, // Hack around jest mocks
        startTime: 1660939855656,
        tags: {
          _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
          apiid: '3gsxz7lha4',
          domain_name: '3gsxz7lha4.execute-api.eu-west-1.amazonaws.com',
          endpoint: '/dev/hello',
          'http.method': 'POST',
          'http.url': 'https://3gsxz7lha4.execute-api.eu-west-1.amazonaws.com/dev/hello',
          'peer.service': 'mock-lambda-service',
          request_id: undefined,
          'resource.name': 'POST /hello',
          resource_names: 'POST /hello',
          service: '3gsxz7lha4.execute-api.eu-west-1.amazonaws.com',
          'service.name': '3gsxz7lha4.execute-api.eu-west-1.amazonaws.com',
          'span.kind': 'server',
          'span.type': 'web',
          stage: 'dev',
        },
      },
    ])
  })

  it('creates an inferred span for API Gateway V1 event with traced authorizers [Token Type]', () => {
    const inferrer = createInferrer(mockWrapperWithFinish)
    inferrer.createInferredSpan(apiGatewayV1TokenAuthorizer, {}, {})
    assert.deepStrictEqual(mockWrapperWithFinish.startSpan.getCall(0).args, [
      'aws.apigateway.authorizer',
      {
        childOf: {},
        startTime: 1666803196780,
        tags: {
          _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
          apiid: '4dyr9xqip7',
          domain_name: '4dyr9xqip7.execute-api.eu-west-1.amazonaws.com',
          endpoint: '/dev/hi',
          'http.method': 'GET',
          'http.url': 'https://4dyr9xqip7.execute-api.eu-west-1.amazonaws.com/dev/hi',
          'peer.service': 'mock-lambda-service',
          request_id: undefined,
          'resource.name': 'GET /hi',
          resource_names: 'GET /hi',
          service: '4dyr9xqip7.execute-api.eu-west-1.amazonaws.com',
          'service.name': '4dyr9xqip7.execute-api.eu-west-1.amazonaws.com',
          'span.kind': 'server',
          'span.type': 'web',
          stage: 'dev',
        },
      },
    ])
    assert.deepStrictEqual(mockWrapperWithFinish.startSpan.getCall(1).args, [
      'aws.apigateway',
      {
        childOf: { finish: mockFinish }, // Hack around jest mocks
        startTime: 1666803196783,
        tags: {
          _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
          apiid: '4dyr9xqip7',
          domain_name: '4dyr9xqip7.execute-api.eu-west-1.amazonaws.com',
          endpoint: '/dev/hi',
          'http.method': 'GET',
          'http.url': 'https://4dyr9xqip7.execute-api.eu-west-1.amazonaws.com/dev/hi',
          'peer.service': 'mock-lambda-service',
          request_id: undefined,
          'resource.name': 'GET /hi',
          resource_names: 'GET /hi',
          service: '4dyr9xqip7.execute-api.eu-west-1.amazonaws.com',
          'service.name': '4dyr9xqip7.execute-api.eu-west-1.amazonaws.com',
          'span.kind': 'server',
          'span.type': 'web',
          stage: 'dev',
        },
      },
    ])
  })

  it('No inferred span for API Gateway V1 event with CACHED authorizers [Token Type]', () => {
    const inferrer = createInferrer(mockWrapperWithFinish)
    inferrer.createInferredSpan(apiGatewayV1TokenAuthorizerCached, {}, {})
    assert.deepStrictEqual(mockWrapperWithFinish.startSpan.getCall(0).args, [
      'aws.apigateway',
      {
        childOf: {}, // Hack around jest mocks
        startTime: 1666803234094,
        tags: {
          _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
          apiid: '4dyr9xqip7',
          domain_name: '4dyr9xqip7.execute-api.eu-west-1.amazonaws.com',
          endpoint: '/dev/hi',
          'http.method': 'GET',
          'http.url': 'https://4dyr9xqip7.execute-api.eu-west-1.amazonaws.com/dev/hi',
          'peer.service': 'mock-lambda-service',
          request_id: undefined,
          'resource.name': 'GET /hi',
          resource_names: 'GET /hi',
          service: '4dyr9xqip7.execute-api.eu-west-1.amazonaws.com',
          'service.name': '4dyr9xqip7.execute-api.eu-west-1.amazonaws.com',
          'span.kind': 'server',
          'span.type': 'web',
          stage: 'dev',
        },
      },
    ])
  })

  it('connects the inferred span for API Gateway V2 event with traced authorizers [Request Type]', () => {
    const inferrer = createInferrer(mockWrapperWithFinish)
    inferrer.createInferredSpan(apiGatewayV2RequestAuthorizer, {}, {})
    assert.deepStrictEqual(mockWrapperWithFinish.startSpan.getCall(0).args, [
      'aws.httpapi',
      {
        childOf: {},
        startTime: 1665596771812,
        tags: {
          _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
          apiid: 'l9flvsey83',
          domain_name: 'l9flvsey83.execute-api.eu-west-1.amazonaws.com',
          endpoint: '/hello',
          'http.method': 'GET',
          'http.url': 'https://l9flvsey83.execute-api.eu-west-1.amazonaws.com/hello',
          'peer.service': 'mock-lambda-service',
          request_id: undefined,
          'resource.name': 'GET /hello',
          resource_names: 'GET /hello',
          service: 'l9flvsey83.execute-api.eu-west-1.amazonaws.com',
          'service.name': 'l9flvsey83.execute-api.eu-west-1.amazonaws.com',
          'span.kind': 'server',
          'span.type': 'web',
          stage: '$default',
        },
      },
    ])
  })

  it('No inferred span for API Gateway V2 event with CACHED authorizers [Request Type]', () => {
    const inferrer = createInferrer(mockWrapperWithFinish)
    inferrer.createInferredSpan(apiGatewayV2TokenAuthorizerCached, {}, {})
    assert.deepStrictEqual(mockWrapperWithFinish.startSpan.getCall(0).args, [
      'aws.httpapi',
      {
        childOf: {},
        startTime: 1665596856876,
        tags: {
          _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
          apiid: 'l9flvsey83',
          domain_name: 'l9flvsey83.execute-api.eu-west-1.amazonaws.com',
          endpoint: '/hello',
          'http.method': 'GET',
          'http.url': 'https://l9flvsey83.execute-api.eu-west-1.amazonaws.com/hello',
          'peer.service': 'mock-lambda-service',
          request_id: undefined,
          'resource.name': 'GET /hello',
          resource_names: 'GET /hello',
          service: 'l9flvsey83.execute-api.eu-west-1.amazonaws.com',
          'service.name': 'l9flvsey83.execute-api.eu-west-1.amazonaws.com',
          'span.kind': 'server',
          'span.type': 'web',
          stage: '$default',
        },
      },
    ])
  })

  it('creates an inferred span for API Gateway Websocket Connect event with traced authorizers [Request Type]', () => {
    const inferrer = createInferrer(mockWrapperWithFinish)
    inferrer.createInferredSpan(apiGatewayWSSRequestAuthorizerConnect, {}, {})
    assert.deepStrictEqual(mockWrapperWithFinish.startSpan.getCall(0).args, [
      'aws.apigateway.authorizer',
      {
        childOf: {},
        startTime: 1666633566931,
        tags: {
          _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
          apiid: '85fj5nw29d',
          connection_id: 'ahVWscZqmjQCI1w=',
          endpoint: '$connect',
          event_type: 'CONNECT',
          'http.url': 'https://85fj5nw29d.execute-api.eu-west-1.amazonaws.com$connect',
          message_direction: 'IN',
          'peer.service': 'mock-lambda-service',
          request_id: undefined,
          'resource.name': '85fj5nw29d.execute-api.eu-west-1.amazonaws.com $connect',
          resource_names: '85fj5nw29d.execute-api.eu-west-1.amazonaws.com $connect',
          service: '85fj5nw29d.execute-api.eu-west-1.amazonaws.com',
          'service.name': '85fj5nw29d.execute-api.eu-west-1.amazonaws.com',
          'span.kind': 'server',
          'span.type': 'web',
        },
      },
    ])
    assert.deepStrictEqual(mockWrapperWithFinish.startSpan.getCall(1).args, [
      'aws.apigateway',
      {
        childOf: { finish: mockFinish }, // Hack around jest mocks
        startTime: 1666633566947,
        tags: {
          _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
          apiid: '85fj5nw29d',
          connection_id: 'ahVWscZqmjQCI1w=',
          endpoint: '$connect',
          event_type: 'CONNECT',
          'http.url': 'https://85fj5nw29d.execute-api.eu-west-1.amazonaws.com$connect',
          message_direction: 'IN',
          'peer.service': 'mock-lambda-service',
          request_id: undefined,
          'resource.name': '85fj5nw29d.execute-api.eu-west-1.amazonaws.com $connect',
          resource_names: '85fj5nw29d.execute-api.eu-west-1.amazonaws.com $connect',
          service: '85fj5nw29d.execute-api.eu-west-1.amazonaws.com',
          'service.name': '85fj5nw29d.execute-api.eu-west-1.amazonaws.com',
          'span.kind': 'server',
          'span.type': 'web',
        },
      },
    ])
  })

  it('clamps authorizer span endTime to startTime when clock skew causes negative duration', () => {
    // Simulate the case where requestTimeEpoch + integrationLatency < parentSpanFinishTime
    // (i.e., API Gateway's reported end is before the authorizer lambda's self-reported finish).
    // This 1ms discrepancy would produce a negative duration.
    const skewedEvent = JSON.parse(JSON.stringify(apiGatewayV1RequestAuthorizer))
    const authorizerHeaders = JSON.parse(
      Buffer.from(skewedEvent.requestContext.authorizer._datadog, 'base64').toString()
    )
    const parentSpanFinishTimeMs = authorizerHeaders['x-datadog-parent-span-finish-time'] / 1e6
    const { requestTimeEpoch } = skewedEvent.requestContext
    // Set integrationLatency so that requestTimeEpoch + integrationLatency < parentSpanFinishTimeMs
    skewedEvent.requestContext.authorizer.integrationLatency = parentSpanFinishTimeMs - requestTimeEpoch - 1
    const inferrer = createInferrer(mockWrapperWithFinish)
    inferrer.createInferredSpan(skewedEvent, {}, {})
    // The second apigateway span must not start before the first one ends,
    // otherwise the authorizer span gets a negative duration.
    const secondApiGatewayStartTime = mockWrapperWithFinish.startSpan.getCall(1).args[1].startTime
    assert.ok(secondApiGatewayStartTime >= parentSpanFinishTimeMs)
  })

  it('No inferred span for API Gateway Websocket Message event with traced authorizers [Request Type]', () => {
    const inferrer = createInferrer(mockWrapperWithFinish)
    inferrer.createInferredSpan(apiGatewayWSSRequestAuthorizerMessage, {}, {})
    assert.deepStrictEqual(mockWrapperWithFinish.startSpan.getCall(0).args, [
      'aws.apigateway',
      {
        childOf: {},
        startTime: 1666633666203,
        tags: {
          _inferred_span: { synchronicity: 'sync', tag_source: 'self' },
          apiid: '85fj5nw29d',
          connection_id: 'ahVWscZqmjQCI1w=',
          endpoint: 'hello',
          event_type: 'MESSAGE',
          'http.url': 'https://85fj5nw29d.execute-api.eu-west-1.amazonaws.comhello',
          message_direction: 'IN',
          'peer.service': 'mock-lambda-service',
          request_id: undefined,
          'resource.name': '85fj5nw29d.execute-api.eu-west-1.amazonaws.com hello',
          resource_names: '85fj5nw29d.execute-api.eu-west-1.amazonaws.com hello',
          service: '85fj5nw29d.execute-api.eu-west-1.amazonaws.com',
          'service.name': '85fj5nw29d.execute-api.eu-west-1.amazonaws.com',
          'span.kind': 'server',
          'span.type': 'web',
        },
      },
    ])
  })
})
