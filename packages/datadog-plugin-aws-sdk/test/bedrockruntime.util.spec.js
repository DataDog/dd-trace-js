'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  extractTextAndResponseReasonConverseFromStream,
} = require('../src/services/bedrockruntime/utils')

describe('bedrockruntime converse stream extractor', () => {
  it('returns an empty message when the stream fails before yielding a chunk', () => {
    const generation = extractTextAndResponseReasonConverseFromStream()

    assert.deepStrictEqual(generation.messages, [{ role: 'assistant', content: '' }])
  })

  it('aggregates streamed text, tool input, metadata, and the stop reason', () => {
    const generation = extractTextAndResponseReasonConverseFromStream([
      { messageStart: { role: 'assistant' } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hel' } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'lo' } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":"Berlin"}' } } } },
      { metadata: { usage: { inputTokens: 2, outputTokens: 3 } } },
      { messageStop: { stopReason: 'tool_use' } },
    ])

    assert.deepStrictEqual(generation.messages, [{
      role: 'assistant',
      content: 'hello',
      toolCalls: [{ name: '', arguments: { city: 'Berlin' }, toolId: '', type: 'toolUse' }],
    }])
    assert.deepStrictEqual(generation.usage, {
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    })
    assert.strictEqual(generation.finishReason, 'tool_use')
  })

  it('emits empty tool-call arguments when the streamed tool-use input is malformed JSON', () => {
    const generation = extractTextAndResponseReasonConverseFromStream([
      { messageStart: { role: 'assistant' } },
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 't-1', name: 'get_weather' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: 'not valid json{' } } } },
      { messageStop: { stopReason: 'tool_use' } },
    ])

    assert.deepStrictEqual(generation.messages, [{
      role: 'assistant',
      toolCalls: [{ name: 'get_weather', arguments: {}, toolId: 't-1', type: 'toolUse' }],
    }])
  })
})
