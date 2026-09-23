'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/core')

const GenAiLLMObsPlugin = require('../../../../src/llmobs/plugins/genai')

// Drives the diagnostic channels directly: the reduced path needs no Google client to exercise.
describe('google-genai gen_ai APM attributes with LLM Observability disabled', () => {
  // the tracer under test subscribes the real plugin to its own prefix, so this subclass takes a
  // private one rather than sharing those channels
  class TestGenAiPlugin extends GenAiLLMObsPlugin {
    static prefix = 'tracing:apm:google:genai-gen-ai-test:request'
  }

  const startCh = dc.channel(`${TestGenAiPlugin.prefix}:start`)
  const asyncEndCh = dc.channel(`${TestGenAiPlugin.prefix}:asyncEnd`)
  const chunkCh = dc.channel('apm:google:genai:request:chunk')

  let plugin
  let apmTags

  beforeEach(() => {
    apmTags = {}
    plugin = new TestGenAiPlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: false },
      service: 'test-service',
    })
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  it('tags generateContent with the model, provider and token usage', () => {
    publish({
      methodName: 'generateContent',
      args: [{ model: 'gemini-2.0-flash' }],
      result: { usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 } },
    })

    assert.equal(apmTags['gen_ai.operation.name'], 'llm')
    assert.equal(apmTags['gen_ai.request.model'], 'gemini-2.0-flash')
    assert.equal(apmTags['gen_ai.provider.name'], 'google')
    assert.equal(apmTags['_dd.llmobs.artificial_gen_ai_tags'], 'true')
    assert.equal(apmTags['gen_ai.usage.input_tokens'], 8)
    assert.equal(apmTags['gen_ai.usage.output_tokens'], 3)
    assert.equal(apmTags['gen_ai.usage.total_tokens'], 11)
  })

  // a streamed call reports its usage on the chunks rather than on a result
  it('reads the usage the streamed chunks report', () => {
    const ctx = buildCtx({ methodName: 'generateContentStream', args: [{ model: 'gemini-2.0-flash' }] })

    startCh.publish(ctx)
    chunkCh.publish({ ctx, chunk: { candidates: [{ content: { parts: [{ text: 'ignored' }] } }] } })
    chunkCh.publish({
      ctx,
      chunk: { usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } },
      done: true,
    })
    asyncEndCh.publish(ctx)

    assert.equal(apmTags['gen_ai.usage.input_tokens'], 4)
    assert.equal(apmTags['gen_ai.usage.output_tokens'], 2)
    assert.equal(apmTags['gen_ai.usage.total_tokens'], 6)

    // the reduced path keeps none of the aggregation the LLMObs payload needs
    assert.equal(ctx.chunks, undefined)
    assert.equal(ctx.isStreaming, undefined)
    assert.equal(ctx.result, undefined)
  })

  it('omits usage when neither the result nor the stream reported any', () => {
    publish({ methodName: 'generateContent', args: [{ model: 'gemini-2.0-flash' }], result: undefined })

    assert.equal(apmTags['gen_ai.operation.name'], 'llm')
    assert.equal(apmTags['gen_ai.usage.total_tokens'], undefined)
  })

  it('emits nothing for an operation with no method name', () => {
    publish({ methodName: undefined, args: [{}], result: undefined })

    assert.deepStrictEqual(apmTags, {})
  })

  function buildCtx ({ methodName, args, result }) {
    const spanContext = {
      _trace: { tags: {} },
      getTags: () => ({}),
      getTag: () => undefined,
      setTag (key, value) {
        apmTags[key] = value
      },
    }

    return { currentStore: { span: { context: () => spanContext } }, methodName, args, result }
  }

  function publish (options) {
    const ctx = buildCtx(options)
    startCh.publish(ctx)
    asyncEndCh.publish(ctx)
  }
})
