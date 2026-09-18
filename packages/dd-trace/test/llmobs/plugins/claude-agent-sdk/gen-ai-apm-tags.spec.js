'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/core')

const plugins = require('../../../../src/llmobs/plugins/claude-agent-sdk')

// Drives the diagnostic channels directly: the reduced path needs no agent session to exercise.
describe('claude-agent-sdk gen_ai APM attributes with LLM Observability disabled', () => {
  const LlmPlugin = plugins.find(plugin => plugin.id === 'claude_agent_sdk_llm_llmobs')
  const startCh = dc.channel(`${LlmPlugin.prefix}:start`)
  const endCh = dc.channel(`${LlmPlugin.prefix}:end`)

  let plugin
  let apmTags

  beforeEach(() => {
    apmTags = {}
    plugin = new LlmPlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: false },
      service: 'test-service',
    })
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  it('tags the inner llm span with the model, session and token usage', () => {
    const spanContext = {
      _trace: { tags: {} },
      setTag (key, value) {
        apmTags[key] = value
      },
    }
    const ctx = {
      currentStore: { span: { context: () => spanContext } },
      model: 'claude-sonnet-4-5',
      sessionId: 'sess-1',
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
    }

    startCh.publish(ctx)
    endCh.publish(ctx)

    assert.deepStrictEqual(apmTags, {
      'gen_ai.operation.name': 'llm',
      'gen_ai.request.model': 'claude-sonnet-4-5',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.application.name': 'test-service',
      'gen_ai.conversation.id': 'sess-1',
      // input tokens are normalized to also count cached tokens
      'gen_ai.usage.input_tokens': 13,
      'gen_ai.usage.output_tokens': 4,
      'gen_ai.usage.total_tokens': 17,
      'gen_ai.usage.cache_read_input_tokens': 2,
      'gen_ai.usage.cache_write_input_tokens': 1,
      '_dd.llmobs.artificial_gen_ai_tags': 'true',
    })
  })
})
