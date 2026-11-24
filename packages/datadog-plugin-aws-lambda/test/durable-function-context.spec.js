'use strict'

// Source assertions from datadog-lambda-js src/trace/durable-function-context.spec.ts at da9fc3c0.

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  parseDurableExecutionArn,
  extractDurableFunctionContext,
  extractDurableExecutionStatus,
} = require('../src/context/durable-function')
describe('durable-function-context', () => {
  describe('parseDurableExecutionArn', () => {
    it('returns execution name and ID for a valid ARN', () => {
      const arn =
        'arn:aws:lambda:us-east-1:123456789012:function:my-func:$LATEST/durable-execution/orde' +
        'r-123/550e8400-e29b-41d4-a716-446655440001'
      const result = parseDurableExecutionArn(arn)
      assert.deepStrictEqual(result, {
        executionName: 'order-123',
        executionId: '550e8400-e29b-41d4-a716-446655440001',
      })
    })
    it('returns undefined for ARN without durable-execution marker', () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:function:my-func:$LATEST'
      const result = parseDurableExecutionArn(arn)
      assert.strictEqual(result, undefined)
    })
    it('returns undefined for malformed ARN with only execution name', () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:function:my-func:$LATEST/durable-execution/order-123'
      const result = parseDurableExecutionArn(arn)
      assert.strictEqual(result, undefined)
    })
    it('returns undefined for malformed ARN with empty execution name', () => {
      const arn =
        'arn:aws:lambda:us-east-1:123456789012:function:my-func:$LATEST/durable-execution//550' +
        'e8400-e29b-41d4-a716-446655440002'
      const result = parseDurableExecutionArn(arn)
      assert.strictEqual(result, undefined)
    })
    it('returns undefined for malformed ARN with empty execution ID', () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:function:my-func:$LATEST/durable-execution/order-123/'
      const result = parseDurableExecutionArn(arn)
      assert.strictEqual(result, undefined)
    })
  })
  describe('extractDurableFunctionContext', () => {
    it('extracts context from event.DurableExecutionArn', () => {
      const event = {
        DurableExecutionArn:
          'arn:aws:lambda:us-east-1:123456789012:function:my-func:1/durable-execution/my-executi' +
          'on/550e8400-e29b-41d4-a716-446655440004',
        CheckpointToken: 'some-token',
        InitialExecutionState: {
          Operations: [],
        },
      }
      const result = extractDurableFunctionContext(event)
      assert.deepStrictEqual(result, {
        'aws.durable.execution_name': 'my-execution',
        'aws.durable.execution_id': '550e8400-e29b-41d4-a716-446655440004',
        'aws.durable.first_invocation': 'false',
      })
    })
    it('sets first_invocation to true when Operations has exactly one entry', () => {
      const event = {
        DurableExecutionArn:
          'arn:aws:lambda:us-east-1:123456789012:function:my-func:1/durable-execution/my-executi' +
          'on/550e8400-e29b-41d4-a716-446655440004',
        InitialExecutionState: {
          Operations: [{ type: 'TaskScheduled' }],
        },
      }
      const result = extractDurableFunctionContext(event)
      assert.strictEqual(result?.['aws.durable.first_invocation'], 'true')
    })
    it('sets first_invocation to false when Operations has more than one entry', () => {
      const event = {
        DurableExecutionArn:
          'arn:aws:lambda:us-east-1:123456789012:function:my-func:1/durable-execution/my-executi' +
          'on/550e8400-e29b-41d4-a716-446655440004',
        InitialExecutionState: {
          Operations: [{ type: 'TaskScheduled' }, { type: 'TaskCompleted' }],
        },
      }
      const result = extractDurableFunctionContext(event)
      assert.strictEqual(result?.['aws.durable.first_invocation'], 'false')
    })
    it('omits first_invocation when InitialExecutionState is absent', () => {
      const event = {
        DurableExecutionArn:
          'arn:aws:lambda:us-east-1:123456789012:function:my-func:1/durable-execution/my-executi' +
          'on/550e8400-e29b-41d4-a716-446655440004',
      }
      const result = extractDurableFunctionContext(event)
      assert.notStrictEqual(result, undefined)
      assert.strictEqual(result?.['aws.durable.first_invocation'], undefined)
    })
    it('returns undefined for regular Lambda event without DurableExecutionArn', () => {
      const event = {
        body: '{"key": "value"}',
        headers: {
          'Content-Type': 'application/json',
        },
      }
      const result = extractDurableFunctionContext(event)
      assert.strictEqual(result, undefined)
    })
    it('returns undefined when event is null', () => {
      const result = extractDurableFunctionContext(null)
      assert.strictEqual(result, undefined)
    })
    it('returns undefined when event is undefined', () => {
      const result = extractDurableFunctionContext(undefined)
      assert.strictEqual(result, undefined)
    })
    it('returns undefined when DurableExecutionArn cannot be parsed', () => {
      const event = {
        DurableExecutionArn: 'invalid-arn-without-durable-execution-marker',
      }
      const result = extractDurableFunctionContext(event)
      assert.strictEqual(result, undefined)
    })
  })
  describe('extractDurableExecutionStatus', () => {
    const durableEvent = {
      DurableExecutionArn:
        'arn:aws:lambda:us-east-1:123456789012:function:my-func:1/durable-execution/my-executi' +
        'on/550e8400-e29b-41d4-a716-446655440004',
    }
    for (const entry of ['SUCCEEDED', 'FAILED', 'PENDING']) {
      it(`returns ${String(entry)} when result.Status is ${String(entry)}`, () => {
        const status = entry
        const result = extractDurableExecutionStatus(durableEvent, { Status: status })
        assert.strictEqual(result, status)
      })
    };
    it('returns undefined when result.Status is not a valid status', () => {
      const result = extractDurableExecutionStatus(durableEvent, { Status: 'UNKNOWN' })
      assert.strictEqual(result, undefined)
    })
    it('returns undefined when result has no Status field', () => {
      const result = extractDurableExecutionStatus(durableEvent, {})
      assert.strictEqual(result, undefined)
    })
    it('returns undefined when result is null', () => {
      const result = extractDurableExecutionStatus(durableEvent, null)
      assert.strictEqual(result, undefined)
    })
    it('returns undefined when event has no DurableExecutionArn', () => {
      const result = extractDurableExecutionStatus({ body: '{}' }, { Status: 'SUCCEEDED' })
      assert.strictEqual(result, undefined)
    })
    it('returns undefined when event is null', () => {
      const result = extractDurableExecutionStatus(null, { Status: 'SUCCEEDED' })
      assert.strictEqual(result, undefined)
    })
  })
})
