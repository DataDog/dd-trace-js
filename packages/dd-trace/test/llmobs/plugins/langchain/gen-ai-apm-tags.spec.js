'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/core')

const plugins = require('../../../../src/llmobs/plugins/langchain')

// Drives the diagnostic channels directly: the reduced path needs no LangChain graph to exercise.
describe('langchain gen_ai APM attributes with LLM Observability disabled', () => {
  const ChatModelPlugin = plugins.find(plugin => plugin.lcType === 'chat_model')

  // the tracer under test subscribes the real langchain plugins to their own prefix, so this
  // subclass takes a private one rather than sharing those channels
  class TestChatModelPlugin extends ChatModelPlugin {
    static prefix = 'tracing:apm:langchain-gen-ai-test:invoke'
  }

  const startCh = dc.channel(`${TestChatModelPlugin.prefix}:start`)
  const asyncEndCh = dc.channel(`${TestChatModelPlugin.prefix}:asyncEnd`)

  let plugin
  let apmTags

  beforeEach(() => {
    apmTags = {}
    plugin = new TestChatModelPlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: false },
      service: 'test-service',
    })
    // a traced provider integration is what demotes the LangChain model span to `workflow`
    plugin.isLLMIntegrationEnabled = () => true
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  // regression: the plugin manager used to be captured when this module first loaded, so a tracer
  // rebuilt afterwards left the lookup pointing at a manager with no plugins, and the LangChain
  // model span kept the `llm` kind the provider span was already emitting
  it('resolves a provider integration through the tracer that owns the plugin', () => {
    const anthropic = { llmobs: { _enabled: true } }
    const owned = new TestChatModelPlugin(
      { _pluginManager: { _pluginsByName: { anthropic } } },
      { llmobs: { DD_LLMOBS_ENABLED: false }, service: 'test-service' }
    )

    assert.equal(owned.isLLMIntegrationEnabled('anthropic'), true)

    anthropic.llmobs._enabled = false
    assert.equal(owned.isLLMIntegrationEnabled('anthropic'), false)
    assert.equal(owned.isLLMIntegrationEnabled('cohere'), false)
  })

  it('defers to the provider integration for a traced chat model call', () => {
    publish()

    assert.equal(apmTags['gen_ai.operation.name'], 'workflow')
  })

  it('claims the llm kind when langchain-openai calls the untraced beta client', () => {
    publish({ response_format: { type: 'json_object' } })

    assert.equal(apmTags['gen_ai.operation.name'], 'llm')
    assert.equal(apmTags['gen_ai.request.model'], 'gpt-4o')
    assert.equal(apmTags['gen_ai.provider.name'], 'openai')
  })

  it('leaves a non-openai provider as a workflow', () => {
    publish({ response_format: { type: 'json_object' } }, 'anthropic')

    assert.equal(apmTags['gen_ai.operation.name'], 'workflow')
  })

  function publish (options, provider = 'openai') {
    const tags = {
      'resource.name': 'langchain.chat_model',
      'langchain.request.provider': provider,
      'langchain.request.model': 'gpt-4o',
    }
    const spanContext = {
      _trace: { tags: {} },
      getTags: () => tags,
      getTag: key => tags[key],
      setTag (key, value) {
        apmTags[key] = value
      },
    }
    const ctx = {
      currentStore: { span: { context: () => spanContext } },
      type: 'chat_model',
      arguments: [[], options],
    }

    startCh.publish(ctx)
    asyncEndCh.publish(ctx)
  }
})
