'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire').noCallThru()

const { assertObjectContains } = require('../../../integration-tests/helpers')

// The instrumentation wraps terminate() and publishes here; the plugin reacts. These unit tests
// drive the plugin directly off the channel. The wrapping itself is covered end-to-end against the
// real SDK in index.spec.js ('trace-checkpoint propagation').
const TERMINATE_CHANNEL = 'apm:aws-durable-execution-sdk-js:terminate'
const terminateCh = channel(TERMINATE_CHANNEL)

// Plugins subscribe to the channel only while enabled; disable them between tests so a publish in
// one test never reaches a plugin left subscribed by another.
const enabledPlugins = []

function loadHandlerPlugin (checkpointSaveCalls) {
  return proxyquire('../src/handler', {
    './trace-checkpoint': {
      saveTraceContextCheckpointIfUpdated: async (...args) => {
        checkpointSaveCalls.push(args)
      },
    },
  })
}

function buildCtx (handler) {
  const invocationEvent = {
    DurableExecutionArn: 'arn:aws:lambda:us-east-1:123456789012:durable-execution/test-exec',
    CheckpointToken: 'test-token',
    InitialExecutionState: { Operations: [] },
  }
  return {
    invocationEvent,
    ctx: {
      arguments: [invocationEvent, {}, {}, 'mode', 'test-token', handler],
    },
  }
}

function buildPlugin (Plugin, tracer) {
  // Mirror Config's handling of DD_DURABLE_CROSS_INVOCATION_TRACING_ENABLED (default-on, disabled
  // only when explicitly "false") so the channel subscription installs the same way it does in
  // production. The real value is read off `_tracerConfig`, not `process.env`, so the env-driven
  // tests below must bridge it here.
  const tracerConfig = {
    DD_DURABLE_CROSS_INVOCATION_TRACING_ENABLED:
      process.env.DD_DURABLE_CROSS_INVOCATION_TRACING_ENABLED !== 'false',
  }
  const plugin = new Plugin(tracer, tracerConfig)
  // operationName() reaches into the tracer's nomenclature, which the bare `tracer`
  // stub above doesn't provide; the resolved name is irrelevant to these tests.
  plugin.operationName = () => 'aws.durable.execute'
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
  // Activate channel subscriptions registered in the constructor. TracingPlugin.configure spreads
  // its argument, so an object (not a bare boolean) is required for `enabled` to survive.
  plugin.configure({ enabled: true })
  enabledPlugins.push(plugin)
  return plugin
}

// Drive the lifecycle the instrumentation + bindStart produce: bindStart opens the execute span,
// the handler wrapper captures the durableContext, then terminate() publishes with its reason.
function runToTermination (plugin, ctx, { durableContext, reason } = {}) {
  plugin.bindStart(ctx)
  if (durableContext !== undefined) ctx.durableContext = durableContext
  ctx.terminationReason = reason
  terminateCh.publish(ctx)
}

describe('handler checkpoint hook', () => {
  afterEach(() => {
    while (enabledPlugins.length > 0) enabledPlugins.pop().configure({ enabled: false })
  })

  it('saves a checkpoint on pending termination', async () => {
    const checkpointSaveCalls = []
    const Plugin = loadHandlerPlugin(checkpointSaveCalls)
    const tracer = {}
    const plugin = buildPlugin(Plugin, tracer)

    const { invocationEvent, ctx } = buildCtx(async () => new Promise(() => {}))
    const durableContext = { checkpoint: { checkpoint: async () => {} } }
    runToTermination(plugin, ctx, { durableContext, reason: 'CALLBACK_PENDING' })
    await setImmediate()

    assert.equal(checkpointSaveCalls.length, 1)
    assert.equal(checkpointSaveCalls[0].length, 5, 'expected 5 positional args (no trailing status)')
    assertObjectContains(checkpointSaveCalls, [[tracer, durableContext, '123', invocationEvent]])
  })

  it('does not save a checkpoint for non-pending termination reasons', async () => {
    const checkpointSaveCalls = []
    const Plugin = loadHandlerPlugin(checkpointSaveCalls)
    const plugin = buildPlugin(Plugin, {})

    const { ctx } = buildCtx(async () => new Promise(() => {}))
    runToTermination(plugin, ctx, {
      durableContext: { checkpoint: { checkpoint: async () => {} } },
      reason: 'CHECKPOINT_FAILED',
    })
    await setImmediate()

    assert.equal(checkpointSaveCalls.length, 0)
  })

  it('does not save a checkpoint for an unknown termination reason (allow-list default)', async () => {
    const checkpointSaveCalls = []
    const Plugin = loadHandlerPlugin(checkpointSaveCalls)
    const plugin = buildPlugin(Plugin, {})

    const { ctx } = buildCtx(async () => new Promise(() => {}))
    runToTermination(plugin, ctx, {
      durableContext: { checkpoint: { checkpoint: async () => {} } },
      reason: 'A_REASON_THE_SDK_HAS_NOT_TAUGHT_US_ABOUT',
    })
    await setImmediate()

    assert.equal(checkpointSaveCalls.length, 0)
  })

  it('saves a checkpoint when terminate is called with no reason (SDK default is OPERATION_TERMINATED)', async () => {
    const checkpointSaveCalls = []
    const Plugin = loadHandlerPlugin(checkpointSaveCalls)
    const plugin = buildPlugin(Plugin, {})

    const { ctx } = buildCtx(async () => new Promise(() => {}))
    runToTermination(plugin, ctx, {
      durableContext: { checkpoint: { checkpoint: async () => {} } },
      reason: undefined,
    })
    await setImmediate()

    assert.equal(checkpointSaveCalls.length, 1)
  })

  it('saves at most once across repeated terminate() calls', async () => {
    const checkpointSaveCalls = []
    const Plugin = loadHandlerPlugin(checkpointSaveCalls)
    const plugin = buildPlugin(Plugin, {})

    const { ctx } = buildCtx(async () => new Promise(() => {}))
    runToTermination(plugin, ctx, {
      durableContext: { checkpoint: { checkpoint: async () => {} } },
      reason: 'CALLBACK_PENDING',
    })
    terminateCh.publish(ctx)
    await setImmediate()

    assert.equal(checkpointSaveCalls.length, 1)
  })

  it('does not save when the durableContext was never captured', async () => {
    const checkpointSaveCalls = []
    const Plugin = loadHandlerPlugin(checkpointSaveCalls)
    const plugin = buildPlugin(Plugin, {})

    const { ctx } = buildCtx(async () => new Promise(() => {}))
    runToTermination(plugin, ctx, { reason: 'CALLBACK_PENDING' })
    await setImmediate()

    assert.equal(checkpointSaveCalls.length, 0)
  })

  describe('DD_DURABLE_CROSS_INVOCATION_TRACING_ENABLED', () => {
    const ENV_KEY = 'DD_DURABLE_CROSS_INVOCATION_TRACING_ENABLED'
    let originalEnv

    beforeEach(() => { originalEnv = process.env[ENV_KEY] })
    afterEach(() => {
      if (originalEnv === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = originalEnv
    })

    it('does not subscribe (so never saves) when set to "false"', async () => {
      process.env[ENV_KEY] = 'false'

      const checkpointSaveCalls = []
      const Plugin = loadHandlerPlugin(checkpointSaveCalls)
      const plugin = buildPlugin(Plugin, {})

      const { ctx } = buildCtx(async () => {})
      runToTermination(plugin, ctx, {
        durableContext: { checkpoint: { checkpoint: async () => {} } },
        reason: 'CALLBACK_PENDING',
      })
      await setImmediate()

      assert.equal(checkpointSaveCalls.length, 0)
      assert.strictEqual(terminateCh.hasSubscribers, false, 'must not subscribe when disabled')
    })

    it('subscribes and saves when set to a truthy value (default-on)', async () => {
      process.env[ENV_KEY] = 'true'

      const checkpointSaveCalls = []
      const Plugin = loadHandlerPlugin(checkpointSaveCalls)
      const plugin = buildPlugin(Plugin, {})

      const { ctx } = buildCtx(async () => {})
      runToTermination(plugin, ctx, {
        durableContext: { checkpoint: { checkpoint: async () => {} } },
        reason: 'CALLBACK_PENDING',
      })
      await setImmediate()

      assert.equal(checkpointSaveCalls.length, 1)
    })
  })
})
