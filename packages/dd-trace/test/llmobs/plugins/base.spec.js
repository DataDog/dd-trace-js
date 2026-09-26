'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const promptTracking = require('../../../src/llmobs/prompts/tracking')

describe('LLMObsPlugin managed prompt tracking', () => {
  let currentStore
  let plugin

  class TracingPlugin {
    constructor (_tracer, tracerConfig) {
      this._tracerConfig = tracerConfig
    }
  }

  class Tagger {
    constructor () {
      this.registerLLMObsSpan = sinon.spy()
      this.tagAutoPrompt = sinon.spy()
    }
  }

  const storage = {
    getStore: () => currentStore,
    enterWith: store => { currentStore = store },
  }
  const LLMObsPlugin = proxyquire('../../../src/llmobs/plugins/base', {
    '../../plugins/tracing': TracingPlugin,
    '../storage': { storage },
    '../tagger': Tagger,
    '../telemetry': { incrementLLMObsSpanStartCount () {} },
  })

  class TestPlugin extends LLMObsPlugin {
    static integration = 'test'

    getLLMObsSpanRegisterOptions () {
      return { kind: 'llm' }
    }

    setLLMObsTags (ctx) {
      ctx.tagged = true
    }
  }

  beforeEach(() => {
    const config = { llmobs: { DD_LLMOBS_ENABLED: true } }
    promptTracking.configurePromptTracking(config)
    plugin = new TestPlugin(null, config)
  })

  afterEach(() => {
    promptTracking.configurePromptTracking({ llmobs: { DD_LLMOBS_ENABLED: false } })
  })

  it('captures, propagates, tags, and restores an exact prompt carrier through the shared lifecycle', () => {
    const parentSpan = {}
    const parentStore = { span: parentSpan }
    const span = {}
    const prompt = { id: 'managed', version: '1', template: 'Hello' }
    const request = { prompt: promptTracking.trackPrompt('Hello', prompt) }
    const ctx = { args: [request], currentStore: { span } }
    currentStore = parentStore

    plugin.start(ctx)

    assert.strictEqual(request.prompt, 'Hello')
    assert.deepStrictEqual(currentStore, { span, prompt })
    sinon.assert.calledOnceWithExactly(plugin._tagger.registerLLMObsSpan, span, {
      parent: parentSpan,
      integration: 'test',
      kind: 'llm',
    })

    plugin.asyncEnd(ctx)
    assert.strictEqual(ctx.tagged, true)
    sinon.assert.calledOnceWithExactly(plugin._tagger.tagAutoPrompt, span, prompt)

    plugin.end(ctx)
    assert.strictEqual(currentStore, parentStore)
  })
})
