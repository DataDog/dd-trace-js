'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/core')

const plugins = require('../../../../src/llmobs/plugins/openai/realtime')

// Drives the diagnostic channels directly: the reduced path needs no realtime socket to exercise.
describe('openai realtime gen_ai APM attributes with LLM Observability disabled', () => {
  const ResponsePlugin = plugins.find(plugin => plugin.id === 'openai_realtime_response_llmobs')

  // the tracer under test subscribes the real plugin to its own prefix, so this subclass takes a
  // private one rather than sharing those channels
  class TestResponsePlugin extends ResponsePlugin {
    static prefix = 'tracing:apm:openai:realtime-gen-ai-test:response'
  }

  const startCh = dc.channel(`${TestResponsePlugin.prefix}:start`)
  const asyncEndCh = dc.channel(`${TestResponsePlugin.prefix}:asyncEnd`)
  const audioCh = dc.channel('dd-trace:openai:realtime:audio')

  let plugin
  let apmTags

  beforeEach(() => {
    apmTags = {}
    plugin = buildPlugin(false)
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  function buildPlugin (llmobsEnabled) {
    const instance = new TestResponsePlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: llmobsEnabled },
      service: 'test-service',
    })
    instance.configure({ enabled: true })
    return instance
  }

  it('tags the response turn with the model, provider, session and token usage', () => {
    publish({
      model: 'gpt-4o-realtime-preview',
      basePath: 'https://api.openai.com/v1',
      sessionId: 'sess-1',
      usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
    })

    assert.equal(apmTags['gen_ai.operation.name'], 'llm')
    assert.equal(apmTags['gen_ai.request.model'], 'gpt-4o-realtime-preview')
    assert.equal(apmTags['gen_ai.provider.name'], 'openai')
    assert.equal(apmTags['gen_ai.conversation.id'], 'sess-1')
    assert.equal(apmTags['_dd.llmobs.artificial_gen_ai_tags'], 'true')
    assert.equal(apmTags['gen_ai.usage.input_tokens'], 11)
    assert.equal(apmTags['gen_ai.usage.output_tokens'], 5)
    assert.equal(apmTags['gen_ai.usage.total_tokens'], 16)
  })

  it('totals the usage when the turn reports no total', () => {
    publish({ usage: { input_tokens: 3, output_tokens: 2 } })

    assert.equal(apmTags['gen_ai.usage.total_tokens'], 5)
  })

  it('omits usage for a turn that reports none', () => {
    publish({})

    assert.equal(apmTags['gen_ai.operation.name'], 'llm')
    assert.equal(apmTags['gen_ai.usage.total_tokens'], undefined)
  })

  // the instrumentation retains a turn's audio only while something subscribes to this channel,
  // and the reduced path never reads it: subscribing would buffer megabytes for no consumer
  it('does not subscribe to the audio channel', () => {
    assert.equal(audioCh.hasSubscribers, false)
  })

  it('subscribes to the audio channel when LLM Observability is enabled', () => {
    const enabled = buildPlugin(true)

    try {
      assert.equal(audioCh.hasSubscribers, true)
    } finally {
      enabled.configure({ enabled: false })
    }

    assert.equal(audioCh.hasSubscribers, false)
  })

  function publish (turn) {
    const spanContext = {
      _trace: { tags: {} },
      getTags: () => ({}),
      getTag: () => undefined,
      setTag (key, value) {
        apmTags[key] = value
      },
    }
    const ctx = { currentStore: { span: { context: () => spanContext } }, turn }

    startCh.publish(ctx)
    asyncEndCh.publish(ctx)
  }
})
