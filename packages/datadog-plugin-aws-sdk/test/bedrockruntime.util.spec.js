'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  extractTextAndResponseReasonConverseFromStream,
} = require('../src/services/bedrockruntime/utils')

describe('bedrockruntime converse stream extractor', () => {
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
