'use strict'

const assert = require('node:assert/strict')
const proxyquire = require('proxyquire').noCallThru()

describe('execute checkpoint hooks', () => {
  it('saves a checkpoint on pending termination even when the handler never settles', async () => {
    const checkpointSaveCalls = []

    const AwsDurableExecutionSdkJsExecutePlugin = proxyquire('../src/execute', {
      './trace-checkpoint': {
        maybeSaveTraceContextCheckpoint: async (...args) => {
          checkpointSaveCalls.push(args)
        },
      },
    })

    const tracer = {
      scope () {
        return {
          active () {
            return {
              context () {
                return { _spanId: 456n }
              },
            }
          },
        }
      },
    }

    const plugin = new AwsDurableExecutionSdkJsExecutePlugin(tracer, {})
    plugin.startSpan = (_name, _options, ctx) => {
      const span = {
        context () {
          return { _spanId: 456n }
        },
      }
      if (ctx && typeof ctx === 'object') {
        ctx.currentStore = { span }
      }
      return span
    }

    let terminateCalls = 0
    const executionContext = {
      terminationManager: {
        terminate () {
          terminateCalls++
        },
      },
    }

    const unresolvedHandler = async () => new Promise(() => {})
    const invocationEvent = {
      DurableExecutionArn: 'arn:aws:lambda:us-east-1:123456789012:durable-execution/test-exec',
      CheckpointToken: 'test-token',
      InitialExecutionState: { Operations: [] },
    }

    const ctx = {
      arguments: [
        invocationEvent,
        {},
        executionContext,
        'mode',
        'test-token',
        unresolvedHandler,
      ],
    }

    plugin.bindStart(ctx)

    const wrappedHandler = ctx.arguments[5]
    const durableContext = {
      checkpoint: {
        checkpoint: async () => {},
      },
    }

    void wrappedHandler({}, durableContext)
    executionContext.terminationManager.terminate({ reason: 'CALLBACK_PENDING' })
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(terminateCalls, 1)
    assert.equal(checkpointSaveCalls.length, 1)
    assert.equal(checkpointSaveCalls[0][0], tracer)
    assert.equal(checkpointSaveCalls[0][2], durableContext)
    assert.equal(checkpointSaveCalls[0][3], '456')
    assert.equal(checkpointSaveCalls[0][4], invocationEvent)
    assert.equal(checkpointSaveCalls[0][5].Status, 'PENDING')
  })

  it('does not save a checkpoint for non-pending termination reasons', async () => {
    const checkpointSaveCalls = []

    const AwsDurableExecutionSdkJsExecutePlugin = proxyquire('../src/execute', {
      './trace-checkpoint': {
        maybeSaveTraceContextCheckpoint: async (...args) => {
          checkpointSaveCalls.push(args)
        },
      },
    })

    const tracer = {
      scope () {
        return {
          active () {
            return {
              context () {
                return { _spanId: 456n }
              },
            }
          },
        }
      },
    }

    const plugin = new AwsDurableExecutionSdkJsExecutePlugin(tracer, {})
    plugin.startSpan = (_name, _options, ctx) => {
      const span = {
        context () {
          return { _spanId: 456n }
        },
      }
      if (ctx && typeof ctx === 'object') {
        ctx.currentStore = { span }
      }
      return span
    }

    const executionContext = {
      terminationManager: {
        terminate () {},
      },
    }

    const unresolvedHandler = async () => new Promise(() => {})
    const invocationEvent = {
      DurableExecutionArn: 'arn:aws:lambda:us-east-1:123456789012:durable-execution/test-exec',
      CheckpointToken: 'test-token',
      InitialExecutionState: { Operations: [] },
    }

    const ctx = {
      arguments: [
        invocationEvent,
        {},
        executionContext,
        'mode',
        'test-token',
        unresolvedHandler,
      ],
    }

    plugin.bindStart(ctx)

    const wrappedHandler = ctx.arguments[5]
    const durableContext = {
      checkpoint: {
        checkpoint: async () => {},
      },
    }

    void wrappedHandler({}, durableContext)
    executionContext.terminationManager.terminate({ reason: 'CHECKPOINT_FAILED' })
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(checkpointSaveCalls.length, 0)
  })

  it('starts aws.durable.execute and finishes it on asyncEnd', () => {
    const AwsDurableExecutionSdkJsExecutePlugin = proxyquire('../src/execute', {
      './trace-checkpoint': {
        maybeSaveTraceContextCheckpoint: async () => {},
      },
    })

    const tracer = {}
    const plugin = new AwsDurableExecutionSdkJsExecutePlugin(tracer, {})
    const startCalls = []
    let finishCount = 0
    const executeSpan = {
      context () {
        return { _spanId: 999n }
      },
      setTag () {},
      finish () {
        finishCount++
      },
    }

    plugin.startSpan = (name, options, ctx) => {
      startCalls.push({ name, options, ctx })
      if (ctx && typeof ctx === 'object') {
        ctx.currentStore = { span: executeSpan }
      }
      return executeSpan
    }

    const ctx = {
      arguments: [
        {
          DurableExecutionArn: 'arn:aws:lambda:us-east-1:123456789012:function:demo:1/durable-execution/demo/exec-1',
          CheckpointToken: 'test-token',
          InitialExecutionState: {
            Operations: [
              {
                Id: 'op-1',
                Name: 'input',
                Status: 'RUNNING',
                StartTimestamp: 1710000000000,
              },
            ],
          },
        },
      ],
    }

    plugin.bindStart(ctx)

    assert.equal(startCalls.length, 1)
    assert.equal(startCalls[0].name, 'aws.durable.execute')

    ctx.result = { Status: 'SUCCEEDED' }
    plugin.asyncEnd(ctx)
    assert.equal(finishCount, 1)
  })

  it('starts execute span on replay invocations', () => {
    const AwsDurableExecutionSdkJsExecutePlugin = proxyquire('../src/execute', {
      './trace-checkpoint': {
        maybeSaveTraceContextCheckpoint: async () => {},
      },
    })

    const tracer = {}
    const plugin = new AwsDurableExecutionSdkJsExecutePlugin(tracer, {})
    const startedSpanNames = []

    plugin.startSpan = (name, _options, ctx) => {
      startedSpanNames.push(name)
      const executeSpan = {
        context () {
          return { _spanId: 123n }
        },
      }
      if (ctx && typeof ctx === 'object') {
        ctx.currentStore = { span: executeSpan }
      }
      return executeSpan
    }

    const ctx = {
      arguments: [
        {
          DurableExecutionArn: 'arn:aws:lambda:us-east-1:123456789012:function:demo:1/durable-execution/demo/exec-2',
          CheckpointToken: 'test-token',
          InitialExecutionState: {
            Operations: [
              {
                Id: 'trace-checkpoint-0',
                Name: '_datadog_0',
                Status: 'SUCCEEDED',
              },
              {
                Id: 'some-op',
                Name: 'step_1',
                Status: 'SUCCEEDED',
              },
            ],
          },
        },
      ],
    }

    plugin.bindStart(ctx)

    assert.deepEqual(startedSpanNames, ['aws.durable.execute'])
  })
})
