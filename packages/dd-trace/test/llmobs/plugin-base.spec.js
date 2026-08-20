'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')

const { storage: llmobsStorage } = require('../../src/llmobs/storage')

class TracingPlugin {
  constructor (tracer, tracerConfig) {
    this._tracerConfig = tracerConfig
  }
}

class LLMObsTagger {
  registerLLMObsSpan () {}
}

const BaseLLMObsPlugin = proxyquire('../../src/llmobs/plugins/base', {
  '../../plugins/tracing': TracingPlugin,
  '../tagger': LLMObsTagger,
  '../telemetry': { incrementLLMObsSpanStartCount () {} },
})

class TestLLMObsPlugin extends BaseLLMObsPlugin {
  getLLMObsSpanRegisterOptions (ctx, parent) {
    this.registerOptionsParent = parent
    return { kind: 'tool' }
  }

  setLLMObsTags () {
    this.storeDuringTagging = llmobsStorage.getStore()
  }
}

describe('BaseLLMObsPlugin', () => {
  let plugin

  beforeEach(() => {
    plugin = new TestLLMObsPlugin(undefined, {
      llmobs: { DD_LLMOBS_ENABLED: true },
    })
  })

  afterEach(() => {
    llmobsStorage.enterWith(undefined)
  })

  it('passes the ambient LLMObs parent to register option resolution', () => {
    const parent = {}
    const ctx = { currentStore: { span: {} } }

    llmobsStorage.enterWith({ span: parent })

    plugin.start(ctx)

    assert.strictEqual(plugin.registerOptionsParent, parent)
  })

  it('restores the parent LLMObs store after async tagging', () => {
    const parentStore = { span: {} }
    const streamedStore = { span: {} }
    const ctx = {
      currentStore: { span: {} },
      llmobs: { parent: parentStore },
    }

    llmobsStorage.enterWith(streamedStore)

    plugin.asyncEnd(ctx)

    assert.strictEqual(plugin.storeDuringTagging, streamedStore)
    assert.strictEqual(llmobsStorage.getStore(), parentStore)
  })

  it('clears the LLMObs store after tagging a root span', () => {
    const streamedStore = { span: {} }
    const ctx = {
      currentStore: { span: {} },
      llmobs: { parent: undefined },
    }

    llmobsStorage.enterWith(streamedStore)

    plugin.asyncEnd(ctx)

    assert.strictEqual(plugin.storeDuringTagging, streamedStore)
    assert.strictEqual(llmobsStorage.getStore(), undefined)
  })

  it('preserves the current store for an unregistered operation', () => {
    const currentStore = { span: {} }
    const ctx = { currentStore: { span: {} } }

    llmobsStorage.enterWith(currentStore)

    plugin.asyncEnd(ctx)

    assert.strictEqual(plugin.storeDuringTagging, currentStore)
    assert.strictEqual(llmobsStorage.getStore(), currentStore)
  })
})
