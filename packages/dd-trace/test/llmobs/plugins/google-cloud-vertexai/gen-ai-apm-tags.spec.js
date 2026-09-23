'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/core')

const VertexAILLMObsPlugin = require('../../../../src/llmobs/plugins/vertexai')

// Drives the diagnostic channels directly: the reduced path needs no Vertex client to exercise.
describe('vertexai gen_ai APM attributes with LLM Observability disabled', () => {
  // the tracer under test subscribes the real plugin to its own prefix, so this subclass takes a
  // private one rather than sharing those channels
  class TestVertexAIPlugin extends VertexAILLMObsPlugin {
    static prefix = 'tracing:apm:vertexai-gen-ai-test:request'
  }

  const startCh = dc.channel(`${TestVertexAIPlugin.prefix}:start`)
  const asyncEndCh = dc.channel(`${TestVertexAIPlugin.prefix}:asyncEnd`)

  let plugin
  let apmTags

  beforeEach(() => {
    apmTags = {}
    plugin = new TestVertexAIPlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: false },
      service: 'test-service',
    })
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  it('tags the model, provider and token usage', () => {
    publish({
      instance: { model: 'publishers/google/models/gemini-1.5-flash' },
      result: {
        response: { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6, totalTokenCount: 18 } },
      },
    })

    assert.equal(apmTags['gen_ai.operation.name'], 'llm')
    assert.equal(apmTags['gen_ai.request.model'], 'gemini-1.5-flash')
    assert.equal(apmTags['gen_ai.provider.name'], 'google')
    assert.equal(apmTags['_dd.llmobs.artificial_gen_ai_tags'], 'true')
    assert.equal(apmTags['gen_ai.usage.input_tokens'], 12)
    assert.equal(apmTags['gen_ai.usage.output_tokens'], 6)
    assert.equal(apmTags['gen_ai.usage.total_tokens'], 18)
  })

  it('omits usage when the response reports none', () => {
    publish({ instance: { model: 'publishers/google/models/gemini-1.5-flash' }, result: { response: {} } })

    assert.equal(apmTags['gen_ai.operation.name'], 'llm')
    assert.equal(apmTags['gen_ai.usage.total_tokens'], undefined)
  })

  // a model-backed span always reports a model, the way the LLMObs span event does
  it('falls back to the default model when the instance names none', () => {
    publish({ instance: {}, result: undefined })

    assert.equal(apmTags['gen_ai.request.model'], 'custom')
  })

  function publish ({ instance, result }) {
    const spanContext = {
      _trace: { tags: {} },
      getTags: () => ({}),
      getTag: () => undefined,
      setTag (key, value) {
        apmTags[key] = value
      },
    }
    const ctx = {
      currentStore: { span: { context: () => spanContext } },
      instance,
      resource: 'vertexai.request',
      result,
    }

    startCh.publish(ctx)
    asyncEndCh.publish(ctx)
  }
})
