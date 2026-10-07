'use strict'

const assert = require('node:assert/strict')

const { appendMessage } = require('../../src/llmobs/plugins/anthropic/util')

describe('anthropic utils', () => {
  it('formats supported tool-result blocks and skips unknown blocks', () => {
    const messages = []

    appendMessage(messages, {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: [
          { type: 'text', text: 'first' },
          { type: 'image' },
          { type: 'unknown' },
          { type: 'text', text: 'second' },
        ],
      }],
    })

    assert.deepStrictEqual(messages, [{
      content: '',
      role: 'user',
      toolResults: [{
        result: 'first,([IMAGE DETECTED]),second',
        toolId: 'tool-1',
        type: 'tool_result',
      }],
    }])
  })
})
