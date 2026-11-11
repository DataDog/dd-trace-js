'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const Sqs = require('../src/services/sqs')
const Stepfunctions = require('../src/services/stepfunctions')

describe('AWS resource identifier tags', () => {
  describe('SQS generateTags', () => {
    const queueUrl = 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue'

    it('tags the queue URL the request addresses', () => {
      const tags = new Sqs({}, {}).generateTags({ QueueUrl: queueUrl }, 'sendMessage')
      assert.ok(tags)

      assert.strictEqual(tags['aws.sqs.queue.url'], queueUrl)
      assert.strictEqual(tags.queuename, 'my-queue')
      assert.strictEqual(tags['cloud.resource_id'], 'arn:aws:sqs:us-east-1:123456789012:my-queue')
    })

    it('does not tag a queue URL when the request only names the queue', () => {
      const tags = new Sqs({}, {}).generateTags({ QueueName: 'my-queue' }, 'createQueue')
      assert.ok(tags)

      assert.strictEqual(tags.queuename, 'my-queue')
      assert.ok(!('aws.sqs.queue.url' in tags))
    })
  })

  describe('Step Functions generateTags', () => {
    const stateMachineArn = 'arn:aws:states:us-east-1:123456789012:stateMachine:my-machine'

    for (const operation of ['startExecution', 'startSyncExecution']) {
      it(`tags the state machine ARN for ${operation}`, () => {
        const tags = new Stepfunctions({}, {}).generateTags({ stateMachineArn }, operation)

        assert.deepStrictEqual(tags, {
          'resource.name': operation,
          statemachinearn: stateMachineArn,
          'aws.step_functions.state_machine.arn': stateMachineArn,
        })
      })
    }

    it('tags the state machine ARN for other operations addressing a state machine', () => {
      const tags = new Stepfunctions({}, {}).generateTags({ stateMachineArn }, 'describeStateMachine')

      assert.deepStrictEqual(tags, {
        'resource.name': 'describeStateMachine',
        'aws.step_functions.state_machine.arn': stateMachineArn,
      })
    })

    it('does not tag a state machine ARN when the request has none', () => {
      const tags = new Stepfunctions({}, {}).generateTags({ executionArn: 'arn' }, 'describeExecution')

      assert.deepStrictEqual(tags, { 'resource.name': 'describeExecution' })
    })
  })
})
