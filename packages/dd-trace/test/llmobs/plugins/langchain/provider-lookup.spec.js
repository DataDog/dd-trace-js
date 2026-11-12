'use strict'

require('../../../setup/core')

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const plugins = require('../../../../src/llmobs/plugins/langchain')

describe('langchain provider integration lookup', () => {
  const ChatModelPlugin = plugins.find(plugin => plugin.lcType === 'chat_model')

  function buildPlugin (pluginsByName) {
    return new ChatModelPlugin(
      { _pluginManager: pluginsByName && { _pluginsByName: pluginsByName } },
      { llmobs: { DD_LLMOBS_ENABLED: true }, service: 'test-service' }
    )
  }

  // regression: the plugin manager used to be captured when this module first loaded, so a tracer
  // rebuilt afterwards left the lookup pointing at a manager with no plugins, and the LangChain
  // model span kept the `llm` kind the provider span was already emitting
  it('resolves a provider integration through the tracer that owns the plugin', () => {
    const anthropic = { llmobs: { _enabled: true } }
    const plugin = buildPlugin({ anthropic })

    assert.equal(plugin.isLLMIntegrationEnabled('anthropic'), true)
    assert.equal(plugin.getKind('chat_model', 'anthropic'), 'workflow')

    anthropic.llmobs._enabled = false
    assert.ok(!plugin.isLLMIntegrationEnabled('anthropic'))
    assert.equal(plugin.getKind('chat_model', 'anthropic'), 'llm')
  })

  it('reports an unsupported or absent integration as disabled', () => {
    const plugin = buildPlugin({ cohere: { llmobs: { _enabled: true } } })

    // the lookup is consumed as a predicate, so falsiness is the contract
    assert.ok(!plugin.isLLMIntegrationEnabled('cohere'))
    assert.ok(!plugin.isLLMIntegrationEnabled('openai'))
  })

  it('does not throw when the tracer exposes no plugin manager', () => {
    assert.ok(!buildPlugin().isLLMIntegrationEnabled('anthropic'))
  })
})
