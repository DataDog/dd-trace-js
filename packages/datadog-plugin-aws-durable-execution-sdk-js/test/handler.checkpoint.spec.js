'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const proxyquire = require('proxyquire').noCallThru()

const { assertObjectContains } = require('../../../integration-tests/helpers')

function loadHandlerPlugin (checkpointSaveCalls) {
  return proxyquire('../src/handler', {
    './trace-checkpoint': {
      saveTraceContextCheckpointIfUpdated: async (...args) => {
        checkpointSaveCalls.push(args)
      },
    },
  })
}

function buildCtx (executionContext, handler) {
  const invocationEvent = {
    DurableExecutionArn: 'arn:aws:lambda:us-east-1:123456789012:durable-execution/test-exec',
    CheckpointToken: 'test-token',
    InitialExecutionState: { Operations: [] },
  }
  return {
    invocationEvent,
    ctx: {
      arguments: [
        invocationEvent,
        {},
        executionContext,
        'mode',
        'test-token',
        handler,
      ],
    },
  }
}

function buildPlugin (Plugin, tracer) {
  const plugin = new Plugin(tracer, {})
  plugin.startSpan = (_name, _options, ctx) => {
    const span = {
      context () {
        return { toSpanId: () => '123' }
      },
    }
    if (ctx && typeof ctx === 'object') {
      ctx.currentStore = { span }
    }
    return span
  }
  return plugin
}

describe('handler checkpoint hook', () => {
  it('saves a checkpoint on pending termination even when the handler never settles', async () => {
    const checkpointSaveCalls = []
    const Plugin = loadHandlerPlugin(checkpointSaveCalls)
    const tracer = {}
    const plugin = buildPlugin(Plugin, tracer)

    let terminateCalls = 0
    const executionContext = {
      terminationManager: {
        terminate () { terminateCalls++ },
      },
    }
    const unresolvedHandler = async () => new Promise(() => {})
    const { invocationEvent, ctx } = buildCtx(executionContext, unresolvedHandler)

    plugin.bindStart(ctx)

    const wrappedHandler = ctx.arguments[5]
    const durableContext = { checkpoint: { checkpoint: async () => {} } }

    void wrappedHandler({}, durableContext)
    executionContext.terminationManager.terminate({ reason: 'CALLBACK_PENDING' })
    await setImmediate()

    assert.equal(terminateCalls, 1)
    assert.equal(checkpointSaveCalls.length, 1)
    assert.equal(checkpointSaveCalls[0].length, 5, 'expected 5 positional args (no trailing status)')
    assertObjectContains(checkpointSaveCalls, [[tracer, durableContext, '123', invocationEvent]])
  })

  it('does not save a checkpoint for non-pending termination reasons', async () => {
    const checkpointSaveCalls = []
    const Plugin = loadHandlerPlugin(checkpointSaveCalls)
    const plugin = buildPlugin(Plugin, {})

    const executionContext = {
      terminationManager: { terminate () {} },
    }
    const unresolvedHandler = async () => new Promise(() => {})
    const { ctx } = buildCtx(executionContext, unresolvedHandler)

    plugin.bindStart(ctx)
    const wrappedHandler = ctx.arguments[5]
    void wrappedHandler({}, { checkpoint: { checkpoint: async () => {} } })
    executionContext.terminationManager.terminate({ reason: 'CHECKPOINT_FAILED' })
    await setImmediate()

    assert.equal(checkpointSaveCalls.length, 0)
  })

  it('does not save a checkpoint for an unknown termination reason (allow-list default)', async () => {
    const checkpointSaveCalls = []
    const Plugin = loadHandlerPlugin(checkpointSaveCalls)
    const plugin = buildPlugin(Plugin, {})

    const executionContext = { terminationManager: { terminate () {} } }
    const { ctx } = buildCtx(executionContext, async () => new Promise(() => {}))

    plugin.bindStart(ctx)
    const wrappedHandler = ctx.arguments[5]
    void wrappedHandler({}, { checkpoint: { checkpoint: async () => {} } })
    executionContext.terminationManager.terminate({ reason: 'A_REASON_THE_SDK_HAS_NOT_TAUGHT_US_ABOUT' })
    await setImmediate()

    assert.equal(checkpointSaveCalls.length, 0)
  })

  it('saves a checkpoint when terminate is called with no reason (SDK default is OPERATION_TERMINATED)', async () => {
    const checkpointSaveCalls = []
    const Plugin = loadHandlerPlugin(checkpointSaveCalls)
    const plugin = buildPlugin(Plugin, {})

    const executionContext = { terminationManager: { terminate () {} } }
    const { ctx } = buildCtx(executionContext, async () => new Promise(() => {}))

    plugin.bindStart(ctx)
    const wrappedHandler = ctx.arguments[5]
    void wrappedHandler({}, { checkpoint: { checkpoint: async () => {} } })
    executionContext.terminationManager.terminate()
    await setImmediate()

    assert.equal(checkpointSaveCalls.length, 1)
  })

  describe('DD_DURABLE_CROSS_INVOCATION_TRACING_ENABLED', () => {
    const ENV_KEY = 'DD_DURABLE_CROSS_INVOCATION_TRACING_ENABLED'
    let originalEnv

    beforeEach(() => { originalEnv = process.env[ENV_KEY] })
    afterEach(() => {
      if (originalEnv === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = originalEnv
    })

    it('skips installing the termination hook when set to "false"', async () => {
      process.env[ENV_KEY] = 'false'

      const checkpointSaveCalls = []
      const Plugin = loadHandlerPlugin(checkpointSaveCalls)
      const plugin = buildPlugin(Plugin, {})

      const originalTerminate = () => {}
      const executionContext = { terminationManager: { terminate: originalTerminate } }
      const { ctx } = buildCtx(executionContext, async () => {})

      plugin.bindStart(ctx)

      assert.strictEqual(executionContext.terminationManager.terminate, originalTerminate,
        'terminate must not be wrapped when cross-invocation tracing is disabled')
      // The handler arg must also remain untouched so the user code runs unaltered.
      assert.strictEqual(typeof ctx.arguments[5], 'function')
      executionContext.terminationManager.terminate({ reason: 'CALLBACK_PENDING' })
      await setImmediate()
      assert.equal(checkpointSaveCalls.length, 0)
    })

    it('still installs the hook when set to a truthy value (default-on)', () => {
      process.env[ENV_KEY] = 'true'

      const Plugin = loadHandlerPlugin([])
      const plugin = buildPlugin(Plugin, {})

      const originalTerminate = () => {}
      const executionContext = { terminationManager: { terminate: originalTerminate } }
      const { ctx } = buildCtx(executionContext, async () => {})

      plugin.bindStart(ctx)
      assert.notStrictEqual(executionContext.terminationManager.terminate, originalTerminate,
        'terminate must be wrapped when cross-invocation tracing is enabled')
    })
  })
})
