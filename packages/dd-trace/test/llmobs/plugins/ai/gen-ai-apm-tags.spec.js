'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/core')

const DdTelemetryPlugin = require('../../../../src/llmobs/plugins/ai/ddTelemetry')
const VercelAiTelemetryPlugin = require('../../../../src/llmobs/plugins/ai/vercelTelemetry')

// Drives the diagnostic channels directly: the reduced path needs no Vercel AI call to exercise.
describe('vercel ai gen_ai APM attributes with LLM Observability disabled', () => {
  // the tracer under test subscribes the real plugin to its own prefix, so this subclass takes a
  // private one rather than sharing those channels
  class TestVercelAiPlugin extends VercelAiTelemetryPlugin {
    static prefix = 'tracing:ai-gen-ai-test:telemetry'
  }

  const startCh = dc.channel(`${TestVercelAiPlugin.prefix}:start`)
  const asyncEndCh = dc.channel(`${TestVercelAiPlugin.prefix}:asyncEnd`)
  const chunkCh = dc.channel('dd-trace:vercel-ai:chunk')

  let plugin
  let apmTags

  beforeEach(() => {
    apmTags = {}
    plugin = new TestVercelAiPlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: false },
      service: 'test-service',
    })
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  it('tags a language model call with the model, provider and token usage', () => {
    publish({
      type: 'languageModelCall',
      event: { modelId: 'gpt-4o', provider: 'openai.chat', functionId: 'my-fn' },
      result: {
        usage: {
          inputTokens: { total: 11, cacheRead: 2, cacheWrite: 1 },
          outputTokens: { total: 5, reasoning: 3 },
        },
      },
    })

    assert.equal(apmTags['gen_ai.operation.name'], 'llm')
    assert.equal(apmTags['gen_ai.request.model'], 'gpt-4o')
    assert.equal(apmTags['_dd.llmobs.artificial_gen_ai_tags'], 'true')
    assert.equal(apmTags['gen_ai.usage.input_tokens'], 11)
    assert.equal(apmTags['gen_ai.usage.output_tokens'], 5)
    assert.equal(apmTags['gen_ai.usage.cache_read_input_tokens'], 2)
    assert.equal(apmTags['gen_ai.usage.cache_write_input_tokens'], 1)
    assert.equal(apmTags['gen_ai.usage.reasoning_output_tokens'], 3)
  })

  // a streamed call reports usage on the finish chunk rather than on the result
  it('reads the usage a streamed finish chunk reports', () => {
    const ctx = buildCtx({
      type: 'languageModelCall',
      event: { modelId: 'gpt-4o', provider: 'openai.chat' },
    })

    startCh.publish(ctx)
    chunkCh.publish({ ctx, chunk: { type: 'text-delta', text: 'ignored' } })
    chunkCh.publish({
      ctx,
      chunk: { type: 'finish', usage: { inputTokens: { total: 4 }, outputTokens: { total: 2 } } },
    })
    asyncEndCh.publish(ctx)

    assert.equal(apmTags['gen_ai.usage.input_tokens'], 4)
    assert.equal(apmTags['gen_ai.usage.output_tokens'], 2)
    assert.equal(ctx.chunks, undefined, 'the reduced path keeps no message bodies')
  })

  it('reports an embed operation as an embedding span with its single token count', () => {
    publish({
      type: 'embed',
      event: { modelId: 'text-embedding-3-small', provider: 'openai.embedding' },
      result: { usage: { tokens: 7 } },
    })

    assert.equal(apmTags['gen_ai.operation.name'], 'embedding')
    assert.equal(apmTags['gen_ai.usage.input_tokens'], 7)
  })

  // generateText wraps the model call, so its own span carries no usage
  it('writes no usage for a workflow operation', () => {
    publish({ type: 'generateText', event: { functionId: 'my-fn' }, result: {} })

    assert.equal(apmTags['gen_ai.operation.name'], 'workflow')
    assert.equal(apmTags['gen_ai.usage.total_tokens'], undefined)
  })

  it('emits nothing for an operation it does not map to a span kind', () => {
    publish({ type: 'somethingElse', event: {}, result: {} })

    assert.deepStrictEqual(apmTags, {})
  })

  function buildCtx ({ type, event, result }) {
    const spanContext = {
      _trace: { tags: {} },
      getTags: () => ({}),
      getTag: () => undefined,
      setTag (key, value) {
        apmTags[key] = value
      },
    }

    return { currentStore: { span: { context: () => spanContext } }, type, event, result }
  }

  function publish (options) {
    const ctx = buildCtx(options)
    startCh.publish(ctx)
    asyncEndCh.publish(ctx)
  }
})

// the older telemetry path reads everything off the span attributes rather than the event
describe('vercel ai dd-telemetry gen_ai APM attributes with LLM Observability disabled', () => {
  class TestDdTelemetryPlugin extends DdTelemetryPlugin {
    static prefix = 'tracing:dd-trace-gen-ai-test:vercel-ai'
  }

  const startCh = dc.channel(`${TestDdTelemetryPlugin.prefix}:start`)
  const asyncEndCh = dc.channel(`${TestDdTelemetryPlugin.prefix}:asyncEnd`)

  let plugin
  let apmTags

  beforeEach(() => {
    apmTags = {}
    plugin = new TestDdTelemetryPlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: false },
      service: 'test-service',
    })
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  it('tags a doGenerate call with the model, provider and token usage', () => {
    publish('ai.doGenerate', {
      'ai.model.id': 'gpt-4o',
      'ai.model.provider': 'openai.chat',
      'ai.usage.inputTokens': 11,
      'ai.usage.outputTokens': 5,
      'ai.usage.totalTokens': 16,
    })

    assert.equal(apmTags['gen_ai.operation.name'], 'llm')
    assert.equal(apmTags['gen_ai.request.model'], 'gpt-4o')
    assert.equal(apmTags['_dd.llmobs.artificial_gen_ai_tags'], 'true')
    assert.equal(apmTags['gen_ai.usage.input_tokens'], 11)
    assert.equal(apmTags['gen_ai.usage.output_tokens'], 5)
    assert.equal(apmTags['gen_ai.usage.total_tokens'], 16)
  })

  // v4 of the SDK reports the counts under different attribute names
  it('accepts the v4 token attribute names', () => {
    publish('ai.doGenerate', {
      'ai.model.id': 'gpt-4o',
      'ai.usage.promptTokens': 3,
      'ai.usage.completionTokens': 2,
    })

    assert.equal(apmTags['gen_ai.usage.input_tokens'], 3)
    assert.equal(apmTags['gen_ai.usage.output_tokens'], 2)
    assert.equal(apmTags['gen_ai.usage.total_tokens'], 5)
  })

  it('reports an embed call with its single token count', () => {
    publish('ai.doEmbed', { 'ai.model.id': 'text-embedding-3-small', 'ai.usage.tokens': 7 })

    assert.equal(apmTags['gen_ai.operation.name'], 'embedding')
    assert.equal(apmTags['gen_ai.usage.input_tokens'], 7)
    assert.equal(apmTags['gen_ai.usage.total_tokens'], 7)
  })

  // the outer `embed` span wraps the model call, so it is a workflow with no usage of its own
  it('writes no usage for the wrapping embed span', () => {
    publish('ai.embed', { 'ai.usage.tokens': 7 })

    assert.equal(apmTags['gen_ai.operation.name'], 'workflow')
    assert.equal(apmTags['gen_ai.usage.input_tokens'], undefined)
  })

  it('emits nothing for a span name it does not map to a kind', () => {
    publish('ai.somethingElse', {})

    assert.deepStrictEqual(apmTags, {})
  })

  function publish (spanName, attributes) {
    const spanContext = {
      _trace: { tags: {} },
      getTags: () => attributes,
      getTag: () => undefined,
      setTag (key, value) {
        apmTags[key] = value
      },
    }
    const ctx = {
      currentStore: { span: { _name: spanName, context: () => spanContext } },
      attributes,
    }

    startCh.publish(ctx)
    asyncEndCh.publish(ctx)
  }
})
