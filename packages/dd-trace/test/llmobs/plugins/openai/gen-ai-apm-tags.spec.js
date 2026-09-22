'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/core')

const OpenAiLLMObsPlugin = require('../../../../src/llmobs/plugins/openai')

// Drives the diagnostic channels directly: the reduced path needs no OpenAI client to exercise.
describe('openai gen_ai APM attributes with LLM Observability disabled', () => {
  // the tracer under test subscribes the real plugin to its own prefix, so this subclass takes a
  // private one rather than sharing those channels
  class TestOpenAiPlugin extends OpenAiLLMObsPlugin {
    static prefix = 'tracing:apm:openai-gen-ai-test:request'
  }

  const startCh = dc.channel(`${TestOpenAiPlugin.prefix}:start`)
  const asyncEndCh = dc.channel(`${TestOpenAiPlugin.prefix}:asyncEnd`)

  let plugin
  let apmTags

  beforeEach(() => {
    apmTags = {}
    plugin = new TestOpenAiPlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: false },
      service: 'test-service',
    })
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  it('tags a chat completion with the request model, provider and token usage', () => {
    publish({
      methodName: 'createChatCompletion',
      args: [{ model: 'gpt-4o' }],
      result: {
        data: {
          model: 'gpt-4o-2024-08-06',
          usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
        },
      },
    })

    assert.equal(apmTags['gen_ai.operation.name'], 'llm')
    assert.equal(apmTags['gen_ai.provider.name'], 'openai')
    assert.equal(apmTags['gen_ai.application.name'], 'test-service')
    assert.equal(apmTags['_dd.llmobs.artificial_gen_ai_tags'], 'true')
    assert.equal(apmTags['gen_ai.usage.input_tokens'], 11)
    assert.equal(apmTags['gen_ai.usage.output_tokens'], 5)
    assert.equal(apmTags['gen_ai.usage.total_tokens'], 16)
  })

  // the response names the model actually served, e.g. the dated version behind an alias
  it('prefers the response model over the requested one', () => {
    publish({
      methodName: 'createChatCompletion',
      args: [{ model: 'gpt-4o' }],
      result: { data: { model: 'gpt-4o-2024-08-06', usage: { prompt_tokens: 1, completion_tokens: 1 } } },
    })

    assert.equal(apmTags['gen_ai.request.model'], 'gpt-4o-2024-08-06')
  })

  it('keeps the requested model when the response names none', () => {
    publish({ methodName: 'createChatCompletion', args: [{ model: 'gpt-4o' }], result: undefined })

    assert.equal(apmTags['gen_ai.request.model'], 'gpt-4o')
    assert.equal(apmTags['gen_ai.usage.total_tokens'], undefined)
  })

  it('reports an embedding call as an embedding span', () => {
    publish({
      methodName: 'createEmbedding',
      args: [{ model: 'text-embedding-3-small' }],
      result: { data: { model: 'text-embedding-3-small', usage: { prompt_tokens: 4, total_tokens: 4 } } },
    })

    assert.equal(apmTags['gen_ai.operation.name'], 'embedding')
    assert.equal(apmTags['gen_ai.usage.input_tokens'], 4)
  })

  it('emits nothing for a method the integration does not trace', () => {
    publish({ methodName: 'listModels', args: [{}], result: undefined })

    assert.deepStrictEqual(apmTags, {})
  })

  function publish ({ methodName, args, result }) {
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
      methodName,
      args,
      basePath: 'https://api.openai.com/v1',
      result,
    }

    startCh.publish(ctx)
    asyncEndCh.publish(ctx)
  }
})
