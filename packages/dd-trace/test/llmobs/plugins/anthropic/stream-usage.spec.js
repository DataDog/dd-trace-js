'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/core')

const AnthropicLLMObsPlugin = require('../../../../src/llmobs/plugins/anthropic')

// Drives the chunk channel directly: the usage-only accumulation the reduced path does needs no
// SDK, and the chunks it reads are the objects the application gets back.
describe('anthropic streamed usage with LLM Observability disabled', () => {
  const chunkCh = dc.channel('apm:anthropic:request:chunk')

  let plugin

  beforeEach(() => {
    plugin = new AnthropicLLMObsPlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: false },
      service: 'test-service',
    })
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  it('accumulates the usage the chunks carry without mutating them', () => {
    const ctx = {}
    const messageStart = {
      type: 'message_start',
      message: {
        role: 'assistant',
        usage: { input_tokens: 31, output_tokens: 0, cache_read_input_tokens: 7 },
      },
    }
    const messageDelta = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 17, cache_creation_input_tokens: 3 },
    }

    chunkCh.publish({ ctx, chunk: messageStart })
    chunkCh.publish({ ctx, chunk: messageDelta })

    assert.deepStrictEqual(ctx.streamedUsage, {
      input_tokens: 31,
      output_tokens: 17,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
    })

    // the chunk the application holds is untouched
    assert.deepStrictEqual(messageStart.message.usage, {
      input_tokens: 31,
      output_tokens: 0,
      cache_read_input_tokens: 7,
    })
  })

  it('leaves the message bodies alone', () => {
    const ctx = {}

    chunkCh.publish({ ctx, chunk: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } })

    assert.equal(ctx.chunks, undefined)
    assert.equal(ctx.streamedUsage, undefined)
  })
})
