'use strict'

const assert = require('node:assert/strict')
const { channel, tracingChannel } = require('dc-polyfill')
const { afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const modelInterceptChannel = channel('dd-trace:vercel-ai:model:intercept')
const resolveLanguageModelChannel = tracingChannel('orchestrion:ai:resolveLanguageModel')

// Same approach as openai.spec.js: stub `addHook` to capture the module callback, then
// run it so the instrumentation registers its orchestrion subscriptions without loading `ai`.
function loadAiInstrumentation () {
  const instrumentPath = require.resolve('../src/helpers/instrument')
  const realInstrument = require(instrumentPath)
  const hookCallbacks = []
  const cache = require.cache[instrumentPath]
  const previousExports = cache.exports

  cache.exports = {
    ...realInstrument,
    addHook (spec, callback) {
      hookCallbacks.push({ spec, callback })
    },
  }

  try {
    delete require.cache[require.resolve('../src/ai')]
    require('../src/ai')
  } finally {
    cache.exports = previousExports
    delete require.cache[require.resolve('../src/ai')]
  }

  if (hookCallbacks.length === 0) throw new Error('ai instrumentation registered no hooks')
  hookCallbacks[0].callback({})
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

describe('vercel ai model interception', () => {
  let model
  let doGenerate

  before(() => {
    loadAiInstrumentation()
  })

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
