'use strict'

const assert = require('node:assert/strict')
const proxyquire = require('proxyquire').noCallThru()

describe('server checkpoint hooks', () => {
  it('saves a checkpoint on pending termination even when the handler never settles', async () => {
    const checkpointSaveCalls = []

    const AwsDurableExecutionSdkJsServerPlugin = proxyquire('../src/server', {
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
                return { _parentId: 123n }
              },
            }
          },
        }
      },
    }

    const plugin = new AwsDurableExecutionSdkJsServerPlugin(tracer, {})
    plugin.startSpan = (_name, _options, ctx) => {
      ctx.currentStore = {
        span: {
          context () {
            return {}
          },
        },
      }
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
    assert.equal(checkpointSaveCalls[0][3], '123')
    assert.equal(checkpointSaveCalls[0][4], invocationEvent)
    assert.equal(checkpointSaveCalls[0][5].Status, 'PENDING')
  })

  it('does not save a checkpoint for non-pending termination reasons', async () => {
    const checkpointSaveCalls = []

    const AwsDurableExecutionSdkJsServerPlugin = proxyquire('../src/server', {
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
                return { _parentId: 123n }
              },
            }
          },
        }
      },
    }

    const plugin = new AwsDurableExecutionSdkJsServerPlugin(tracer, {})
    plugin.startSpan = (_name, _options, ctx) => {
      ctx.currentStore = {
        span: {
          context () {
            return {}
          },
        },
      }
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
})
