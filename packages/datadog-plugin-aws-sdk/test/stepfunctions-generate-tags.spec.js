'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const Stepfunctions = require('../src/services/stepfunctions')

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
