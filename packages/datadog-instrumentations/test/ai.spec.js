'use strict'

const assert = require('node:assert/strict')
const { channel, tracingChannel } = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { getActivationSetup } = require('../src/helpers/rewriter/instrumentation-registry')

const modelInterceptChannel = channel('dd-trace:vercel-ai:model:intercept')
const resolveLanguageModelChannel = tracingChannel('orchestrion:ai:resolveLanguageModel')
const aiSdkTelemetryChannel = tracingChannel('ai:telemetry')
const chunkChannel = channel('dd-trace:vercel-ai:chunk')

const channelNames = [
  'orchestrion:ai:getTracer',
  'orchestrion:ai:selectTelemetryAttributes',
  'orchestrion:ai:includeRuntimeContext',
  'orchestrion:ai:resolveLanguageModel',
  'ai:telemetry',
]

/**
 * Loads a fresh copy of the instrumentation and runs the registry's activation setup for every given
 * version, the same way the rewriter does once per evaluated rewrite target. Counts the subscriptions
 * made on each channel and returns a cleanup that removes them, so every load starts from scratch.
 *
 * @param {string[]} versions
 * @returns {{ counts: Record<string, number>, deactivate: () => void }}
 */
function activateAi (versions) {
  const dcPath = require.resolve('dc-polyfill')
  const dcCache = require.cache[dcPath]
  const dcExports = dcCache.exports
  const subscriptionCounts = new Map(channelNames.map(name => [name, 0]))
  const subscriptions = []

  dcCache.exports = {
    ...dcExports,
    tracingChannel (name) {
      const tracingChannel = dcExports.tracingChannel(name)
      if (!subscriptionCounts.has(name)) return tracingChannel

      // Delegate to the real channel so its sub-channels (start, asyncEnd, ...) keep working.
      return new Proxy(tracingChannel, {
        get (target, property) {
          if (property !== 'subscribe') return Reflect.get(target, property, target)

          return handlers => {
            subscriptionCounts.set(name, subscriptionCounts.get(name) + 1)
            subscriptions.push({ target, handlers })
            return target.subscribe(handlers)
          }
        },
      })
    },
  }

  const setup = getActivationSetup('ai')
  try {
    delete require.cache[require.resolve('../src/ai')]
    for (const version of versions) setup({ moduleName: 'ai', version })
  } finally {
    dcCache.exports = dcExports
    delete require.cache[require.resolve('../src/ai')]
  }

  return {
    counts: Object.fromEntries(subscriptionCounts),
    deactivate () {
      for (const { target, handlers } of subscriptions) target.unsubscribe(handlers)
    },
  }
}

/**
 * Emits the same `resolveLanguageModel` event the AI SDK does, so the tests drive the
 * instrumentation's real entry point.
 *
 * @param {unknown} requested
 * @param {object} [resolved]
 */
function resolveLanguageModel (requested, resolved = requested) {
  resolveLanguageModelChannel.end.publish({ arguments: [requested], result: resolved })
}

function subscribeIntercept (onIntercept = () => {}) {
  const calls = []
  const handler = ctx => {
    calls.push(ctx)
    onIntercept(ctx)
  }
  modelInterceptChannel.subscribe(handler)
  return { calls, unsubscribe: () => modelInterceptChannel.unsubscribe(handler) }
}

describe('vercel ai activation setup', () => {
  let activation

  afterEach(() => {
    activation?.deactivate()
    activation = undefined
  })

  it('subscribes the orchestrion channels once when only pre-v7 targets activate', () => {
    activation = activateAi(['4.0.0', '5.1.0', '6.0.0', '6.0.0'])

    assert.deepStrictEqual(activation.counts, {
      'orchestrion:ai:getTracer': 1,
      'orchestrion:ai:selectTelemetryAttributes': 1,
      'orchestrion:ai:includeRuntimeContext': 1,
      'orchestrion:ai:resolveLanguageModel': 1,
      'ai:telemetry': 0,
    })
  })

  // v7 rewrite targets still publish includeRuntimeContext and resolveLanguageModel.
  it('subscribes the orchestrion and telemetry channels once when only v7 targets activate', () => {
    activation = activateAi(['7.0.0', '7.0.0', '7.1.0'])

    assert.deepStrictEqual(activation.counts, {
      'orchestrion:ai:getTracer': 1,
      'orchestrion:ai:selectTelemetryAttributes': 1,
      'orchestrion:ai:includeRuntimeContext': 1,
      'orchestrion:ai:resolveLanguageModel': 1,
      'ai:telemetry': 1,
    })
  })

  it('adds the telemetry subscription when a v7 copy activates after an older one', () => {
    activation = activateAi(['6.0.0', '7.0.0'])

    assert.deepStrictEqual(activation.counts, {
      'orchestrion:ai:getTracer': 1,
      'orchestrion:ai:selectTelemetryAttributes': 1,
      'orchestrion:ai:includeRuntimeContext': 1,
      'orchestrion:ai:resolveLanguageModel': 1,
      'ai:telemetry': 1,
    })
  })

  it('applies runtime context telemetry defaults for v7', () => {
    activation = activateAi(['7.0.0'])
    const options = { runtimeContext: { userId: 'u', organizationId: 'o' } }
    const ctx = { arguments: [options] }

    tracingChannel('orchestrion:ai:includeRuntimeContext').start.publish(ctx)

    assert.deepStrictEqual(ctx.arguments[0], {
      ...options,
      telemetry: { includeRuntimeContext: { userId: true, organizationId: true } },
    })
  })

  it('publishes v7 stream chunks and ends the telemetry span on finish', async () => {
    activation = activateAi(['7.0.0'])
    const chunks = [{ type: 'text-delta', text: 'hi' }, { type: 'finish' }]
    const published = []
    // Like the plugins, mark the stream consumed so the re-emitted asyncEnd is not wrapped again.
    const onChunk = message => {
      published.push({ ...message })
      message.ctx.streamConsumed = message.done
    }
    const asyncEnds = []
    const handlers = { asyncEnd: ctx => asyncEnds.push(ctx) }
    const ctx = {
      isStream: true,
      result: {
        stream: new ReadableStream({
          start (controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
          },
        }),
      },
    }

    chunkChannel.subscribe(onChunk)
    try {
      aiSdkTelemetryChannel.asyncEnd.publish(ctx)
      aiSdkTelemetryChannel.subscribe(handlers)

      const received = []
      for await (const chunk of ctx.result.stream) received.push(chunk)

      assert.deepStrictEqual(received, chunks)
      assert.deepStrictEqual(published, [
        { ctx, chunk: chunks[0], done: false },
        { ctx, chunk: chunks[1], done: true },
      ])
      assert.deepStrictEqual(asyncEnds, [ctx])
    } finally {
      chunkChannel.unsubscribe(onChunk)
      aiSdkTelemetryChannel.unsubscribe(handlers)
    }
  })
})

describe('vercel ai model interception', () => {
  let model
  let doGenerate
  let activation

  // AI Guard intercepts models on every version, including v7, which is activated alone here.
  before(() => {
    activation = activateAi(['7.0.0'])
  })

  after(() => activation.deactivate())

  beforeEach(() => {
    doGenerate = sinon.stub().resolves({ content: [] })
    model = { doGenerate }
  })

  afterEach(() => {
    sinon.restore()
  })

  it('calls the original directly when nothing is subscribed', () => {
    resolveLanguageModel(model)

    return model.doGenerate({ prompt: [] }).then(() => sinon.assert.calledOnce(doGenerate))
  })

  it('publishes the native call data per call', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    resolveLanguageModel(model)

    const options = { prompt: [{ role: 'user' }] }
    return model.doGenerate(options)
      .then(() => {
        assert.strictEqual(calls.length, 1)
        assert.strictEqual(calls[0].method, 'doGenerate')
        assert.deepStrictEqual(calls[0].arguments, [options])
      })
      .finally(unsubscribe)
  })

  it('wraps the resolved model when the SDK built it from a string id', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    resolveLanguageModel('openai/gpt-4o', model)

    return model.doGenerate({ prompt: [] })
      .then(() => assert.strictEqual(calls.length, 1))
      .finally(unsubscribe)
  })

  it('wraps the caller-supplied model when it differs from the resolved one', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    const resolved = { doGenerate: sinon.stub().resolves({ content: [] }) }
    resolveLanguageModel(model, resolved)

    return model.doGenerate({ prompt: [] })
      .then(() => resolved.doGenerate({ prompt: [] }))
      .then(() => assert.strictEqual(calls.length, 1))
      .finally(unsubscribe)
  })

  it('does not wrap the same model twice', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    resolveLanguageModel(model)
    resolveLanguageModel(model)

    return model.doGenerate({ prompt: [] })
      .then(() => assert.strictEqual(calls.length, 1))
      .finally(unsubscribe)
  })

  it('starts the model call without waiting for beforeResult', () => {
    let release
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.beforeResult = () => new Promise(resolve => { release = resolve })
    })
    resolveLanguageModel(model)

    const pending = model.doGenerate({ prompt: [{ role: 'user' }] })

    return new Promise(resolve => setImmediate(resolve))
      .then(() => {
        sinon.assert.calledOnce(doGenerate)
        release()
        return pending
      })
      .finally(unsubscribe)
  })

  it('lets a subscriber replace the delivered result', () => {
    const replacement = { content: [{ type: 'text', text: 'redacted' }] }
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.onResult = () => replacement
    })
    resolveLanguageModel(model)

    return model.doGenerate({ prompt: [{ role: 'user' }] })
      .then(result => assert.strictEqual(result, replacement))
      .finally(unsubscribe)
  })

  it('rejects the call when beforeResult rejects', () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.beforeResult = () => Promise.reject(err)
    })
    resolveLanguageModel(model)

    return assert.rejects(() => model.doGenerate({ prompt: [{ role: 'user' }] }), e => e === err)
      .finally(unsubscribe)
  })

  it('publishes for doStream as well', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    const doStream = sinon.stub().resolves({ stream: {} })
    const streamModel = { doStream }
    resolveLanguageModel(streamModel)

    return streamModel.doStream({ prompt: [] })
      .then(() => assert.strictEqual(calls[0].method, 'doStream'))
      .finally(unsubscribe)
  })
})
