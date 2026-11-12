'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const guards = require('../src/event-type-guards')

// The source has no standalone guard/validator specs. These cases pin their detection boundaries.
describe('Lambda event guards', () => {
  const cases = [
    ['isAPIGatewayEvent', { requestContext: { stage: '' }, httpMethod: '', resource: '' }],
    ['isAPIGatewayEventV2', { requestContext: { domainName: 'api.example' }, version: '2.0', rawQueryString: '' }],
    ['isAPIGatewayWebsocketEvent', { requestContext: { messageDirection: '' } }],
    ['isALBEvent', { requestContext: { elb: {} } }],
    ['isCloudWatchLogsEvent', { awslogs: {} }],
    ['isCloudWatchEvent', { source: 'aws.events' }],
    ['isCloudFrontRequestEvent', { Records: [{ cf: {} }] }],
    ['isDynamoDBStreamEvent', { Records: [{ dynamodb: {} }] }],
    ['isKinesisStreamEvent', { Records: [{ kinesis: {} }] }],
    ['isS3Event', { Records: [{ s3: {} }] }],
    ['isSNSEvent', { Records: [{ Sns: {} }] }],
    ['isSQSEvent', { Records: [{ eventSource: 'aws:sqs' }] }],
    ['isAppSyncResolverEvent', { info: { selectionSetGraphQL: '' } }],
    ['isEventBridgeEvent', { 'detail-type': '' }],
    ['isMSKEvent', { eventSource: 'aws:kafka', records: {} }],
    ['isDurableExecutionEvent', { DurableExecutionArn: '' }],
    ['isStepFunctionsEvent', { Execution: {}, State: {}, StateMachine: {} }],
  ]

  for (const [name, event] of cases) {
    it(`${name} recognizes the source's minimum shape and rejects an empty event`, () => {
      assert.strictEqual(guards[name](event), true)
      assert.strictEqual(guards[name]({}), false)
    })
  }

  it('preserves the Lambda URL predicate return value and domain substring match', () => {
    assert.strictEqual(guards.isLambdaUrlEvent(undefined), undefined)
    assert.strictEqual(guards.isLambdaUrlEvent({}), undefined)
    assert.strictEqual(guards.isLambdaUrlEvent({ requestContext: { domainName: 'example.com' } }), false)
    assert.strictEqual(guards.isLambdaUrlEvent({ requestContext: { domainName: 'a.lambda-url.us-east-1' } }), true)
  })

  it('requires every REST and HTTP API discriminator and excludes Lambda URLs from HTTP API', () => {
    const rest = cases[0][1]
    for (const key of ['requestContext', 'httpMethod', 'resource']) {
      const event = { ...rest }
      delete event[key]
      assert.strictEqual(guards.isAPIGatewayEvent(event), false, key)
    }
    assert.strictEqual(guards.isAPIGatewayEvent({ ...rest, requestContext: {} }), false)
    const http = cases[1][1]
    for (const key of ['requestContext', 'version', 'rawQueryString']) {
      const event = { ...http }
      delete event[key]
      assert.strictEqual(guards.isAPIGatewayEventV2(event), false, key)
    }
    assert.strictEqual(guards.isAPIGatewayEventV2({ ...http, version: '1.0' }), false)
    assert.strictEqual(guards.isAPIGatewayEventV2({
      ...http, requestContext: { domainName: 'a.lambda-url.us-east-1' },
    }), false)
    assert.throws(() => guards.isAPIGatewayEventV2({ ...http, requestContext: {} }), { name: 'TypeError' })
  })

  for (const [name, key] of [
    ['isCloudFrontRequestEvent', 'cf'], ['isDynamoDBStreamEvent', 'dynamodb'],
    ['isKinesisStreamEvent', 'kinesis'], ['isS3Event', 's3'], ['isSNSEvent', 'Sns'],
  ]) {
    it(`${name} checks only the first record and tests presence rather than truthiness`, () => {
      for (const Records of [undefined, null, {}, [], [{}], [{}, { [key]: {} }]]) {
        assert.strictEqual(guards[name]({ Records }), false)
      }
      assert.strictEqual(guards[name]({ Records: [{ [key]: null }] }), true)
      assert.throws(() => guards[name]({ Records: [null] }), { name: 'TypeError' })
    })
  }

  for (const [name, file, body] of [
    ['isSNSSQSEvent', 'snssqs', { Type: 'Notification', TopicArn: 'topic' }],
    ['isEventBridgeSQSEvent', 'eventbridge-sqs', { 'detail-type': '' }],
  ]) {
    it(`${name} recognizes the source envelope fixture`, () => {
      assert.strictEqual(guards[name](require(`./fixtures/${file}.json`)), true)
    })

    it(`${name} requires SQS, parses only the first body and rejects malformed envelopes`, () => {
      const record = { eventSource: 'aws:sqs', body: JSON.stringify(body) }
      assert.strictEqual(guards[name]({ Records: [record] }), true)
      assert.strictEqual(guards[name]({ Records: [{ ...record, eventSource: 'aws:sns' }] }), false)
      assert.strictEqual(guards[name]({ Records: [{ eventSource: 'aws:sqs' }, record] }), false)
      for (const value of [undefined, '', '{', 'null', '[]', '{}', '"text"', '42']) {
        assert.strictEqual(guards[name]({ Records: [{ ...record, body: value }] }), false)
      }
      for (const Records of [undefined, null, {}, []]) {
        assert.strictEqual(guards[name]({ Records }), false)
      }
    })
  }

  it('requires SNS Notification and a truthy TopicArn inside SQS', () => {
    for (const body of [
      { Type: 'Notification' }, { Type: 'Notification', TopicArn: '' },
      { Type: 'SubscriptionConfirmation', TopicArn: 'topic' },
    ]) {
      assert.strictEqual(guards.isSNSSQSEvent({
        Records: [{ eventSource: 'aws:sqs', body: JSON.stringify(body) }],
      }), false)
    }
  })

  it('keeps EventBridge presence semantics inside SQS', () => {
    assert.strictEqual(guards.isEventBridgeSQSEvent({
      Records: [{ eventSource: 'aws:sqs', body: '{"detail-type":null}' }],
    }), true)
  })

  it('requires a non-null non-array records object for MSK', () => {
    for (const records of [undefined, null, [], 'records', 0, false]) {
      assert.strictEqual(guards.isMSKEvent({ eventSource: 'aws:kafka', records }), false)
    }
    assert.strictEqual(guards.isMSKEvent({ eventSource: 'aws:kafka', records: { 'topic-0': [] } }), true)
    assert.strictEqual(guards.isMSKEvent({ eventSource: 'aws:sqs', records: {} }), false)
    assert.strictEqual(guards.isMSKEvent(null), false)
  })

  it('requires a string DurableExecutionArn without validating its contents', () => {
    assert.strictEqual(guards.isDurableExecutionEvent({ DurableExecutionArn: 'arn:aws:lambda:execution' }), true)
    for (const DurableExecutionArn of [undefined, null, 0, {}, []]) {
      assert.strictEqual(guards.isDurableExecutionEvent({ DurableExecutionArn }), false)
    }
  })

  it('unwraps Step Functions Payload then _datadog without recursing or mutating', () => {
    const state = require('./fixtures/states.json')._datadog
    for (const event of [state, { Payload: state }, { _datadog: state }, { Payload: { _datadog: state } }]) {
      const before = JSON.stringify(event)
      assert.strictEqual(guards.isStepFunctionsEvent(event), true)
      assert.strictEqual(JSON.stringify(event), before)
    }
    assert.strictEqual(guards.isStepFunctionsEvent({ _datadog: { Payload: state } }), false)
    assert.strictEqual(guards.isStepFunctionsEvent({ Payload: { Payload: state } }), false)
    assert.strictEqual(guards.isStepFunctionsEvent({ ...state, Payload: {} }), false)
    assert.strictEqual(guards.isStepFunctionsEvent({ ...state, _datadog: {} }), false)
  })

  it('preserves the source Step Functions null/object and malformed envelope behavior', () => {
    assert.strictEqual(guards.isStepFunctionsEvent({ Execution: null, State: [], StateMachine: null }), true)
    for (const event of [{ Payload: null }, { _datadog: null }, null, undefined]) {
      assert.throws(() => guards.isStepFunctionsEvent(event), { name: 'TypeError' })
    }
    assert.strictEqual(guards.isStepFunctionsEvent({ Execution: {}, State: {}, StateMachine: 'arn' }), false)
  })
})
