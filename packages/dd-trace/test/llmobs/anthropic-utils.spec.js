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

  it('records server tool use and web search results without encrypted content', () => {
    const messages = []

    appendMessage(messages, {
      role: 'assistant',
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [{ type: 'web_search_result', url: 'https://a.test', title: 'A', encrypted_content: 'secret' }],
        },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_2',
          content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
        },
      ],
    })

    assert.deepStrictEqual(messages, [
      {
        content: '',
        role: 'assistant',
        toolCalls: [{ name: 'web_search', arguments: { query: 'q' }, toolId: 'srvtoolu_1', type: 'server_tool_use' }],
      },
      {
        content: '',
        role: 'assistant',
        toolResults: [{
          result: '{"sources":[{"url":"https://a.test","title":"A"}]}',
          toolId: 'srvtoolu_1',
          type: 'tool_result',
        }],
      },
      {
        content: '',
        role: 'assistant',
        toolResults: [{
          result: '{"type":"web_search_tool_result_error","error_code":"max_uses_exceeded"}',
          toolId: 'srvtoolu_2',
          type: 'tool_result',
        }],
      },
    ])
  })
})
