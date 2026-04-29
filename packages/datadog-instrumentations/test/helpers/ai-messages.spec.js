'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const {
  convertVercelPromptToMessages,
  convertFilePartToImageUrl,
  buildOutputMessages,
  buildTextOutputMessages,
  buildToolCallOutputMessages,
  convertOpenAIResponseItemsToMessages,
  openAIResponseContentToMessageContent,
} = require('../../src/helpers/ai-messages')

describe('ai-messages', () => {
  describe('convertVercelPromptToMessages', () => {
    it('should return empty array for non-array input', () => {
      assert.deepStrictEqual(convertVercelPromptToMessages(null), [])
      assert.deepStrictEqual(convertVercelPromptToMessages(undefined), [])
      assert.deepStrictEqual(convertVercelPromptToMessages('string'), [])
    })

    it('should return empty array for empty array', () => {
      assert.deepStrictEqual(convertVercelPromptToMessages([]), [])
    })

    it('should convert system messages', () => {
      const prompt = [{ role: 'system', content: 'You are helpful' }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [
        { role: 'system', content: 'You are helpful' },
      ])
    })

    it('should handle system message with non-string content', () => {
      const prompt = [{ role: 'system', content: 123 }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [
        { role: 'system', content: '' },
      ])
    })

    it('should ignore user messages with non-array content', () => {
      const prompt = [{ role: 'user', content: 'Hello' }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [])
    })

    it('should convert user messages with text-only content array', () => {
      const prompt = [{
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'World' },
        ],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [
        { role: 'user', content: 'Hello\nWorld' },
      ])
    })

    it('should convert user messages with file part containing image URL string', () => {
      const prompt = [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'file', data: 'https://example.com/photo.png', mediaType: 'image/png' },
        ],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image_url', image_url: { url: 'https://example.com/photo.png' } },
        ],
      }])
    })

    it('should convert user messages with file part containing image data URL', () => {
      const prompt = [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'file', data: 'data:image/jpeg;base64,abc123', mediaType: 'image/jpeg' },
        ],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc123' } },
        ],
      }])
    })

    it('should convert user messages with file part containing URL object', () => {
      const prompt = [{
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze' },
          { type: 'file', data: new URL('https://example.com/img.jpg'), mediaType: 'image/jpeg' },
        ],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [{
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze' },
          { type: 'image_url', image_url: { url: 'https://example.com/img.jpg' } },
        ],
      }])
    })

    it('should convert user messages with file part containing base64 string', () => {
      const prompt = [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'file', data: 'iVBORw0KGgo=', mediaType: 'image/webp' },
        ],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'data:image/webp;base64,iVBORw0KGgo=' } },
        ],
      }])
    })

    it('should convert user messages with file part containing Uint8Array', () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47])
      const prompt = [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe' },
          { type: 'file', data: bytes, mediaType: 'image/png' },
        ],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` } },
        ],
      }])
    })

    it('should ignore file parts with non-image media types', () => {
      const prompt = [{
        role: 'user',
        content: [
          { type: 'text', text: 'Read this PDF' },
          { type: 'file', data: 'base64data', mediaType: 'application/pdf' },
        ],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [
        { role: 'user', content: 'Read this PDF' },
      ])
    })

    it('should skip user messages with only unsupported parts', () => {
      const prompt = [{
        role: 'user',
        content: [{ type: 'file', data: 'base64data', mediaType: 'application/pdf' }],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [])
    })

    it('should skip user messages with empty content arrays', () => {
      const prompt = [{ role: 'user', content: [] }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [])
    })

    it('should convert assistant messages with text content', () => {
      const prompt = [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'I can help' },
          { type: 'text', text: 'with that' },
        ],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [
        { role: 'assistant', content: 'I can help\nwith that' },
      ])
    })

    it('should ignore assistant messages with non-array content', () => {
      const prompt = [{
        role: 'assistant',
        content: 'Sure, let me check',
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [])
    })

    it('should convert assistant messages with tool calls', () => {
      const prompt = [{
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'search',
          args: { query: 'test' },
        }],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [{
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          function: {
            name: 'search',
            arguments: '{"query":"test"}',
          },
        }],
      }])
    })

    it('should handle assistant tool calls with string args', () => {
      const prompt = [{
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'search',
          args: '{"query":"test"}',
        }],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [{
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          function: {
            name: 'search',
            arguments: '{"query":"test"}',
          },
        }],
      }])
    })

    it('should convert assistant tool calls using input field', () => {
      const prompt = [{
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'search',
          input: { query: 'test' },
        }],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [{
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          function: {
            name: 'search',
            arguments: '{"query":"test"}',
          },
        }],
      }])
    })

    it('should convert tool result messages', () => {
      const prompt = [{
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call_1',
          result: 'Found 5 results',
        }],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [{
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Found 5 results',
      }])
    })

    it('should convert tool result with non-string result', () => {
      const prompt = [{
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call_1',
          result: { count: 5 },
        }],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [{
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"count":5}',
      }])
    })

    it('should convert tool result using output field', () => {
      const prompt = [{
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call_1',
          output: { count: 5 },
        }],
      }]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [{
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"count":5}',
      }])
    })

    it('should convert a full multi-turn conversation with images', () => {
      const prompt = [
        { role: 'system', content: 'Be helpful' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'file', data: 'https://example.com/photo.png', mediaType: 'image/png' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'It shows a cat' }] },
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'fetchPage',
            args: { url: 'https://example.com' },
          }],
        },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'call_1',
            result: 'Page content',
          }],
        },
      ]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [
        { role: 'system', content: 'Be helpful' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'https://example.com/photo.png' } },
          ],
        },
        { role: 'assistant', content: 'It shows a cat' },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_1',
            function: { name: 'fetchPage', arguments: '{"url":"https://example.com"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'Page content' },
      ])
    })

    it('should skip unknown roles', () => {
      const prompt = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        { role: 'unknown', content: 'ignored' },
      ]
      assert.deepStrictEqual(convertVercelPromptToMessages(prompt), [
        { role: 'user', content: 'Hello' },
      ])
    })
  })

  describe('convertFilePartToImageUrl', () => {
    it('should return undefined for unsupported data types', () => {
      assert.strictEqual(convertFilePartToImageUrl({ type: 'file', data: 42, mediaType: 'image/png' }), undefined)
      assert.strictEqual(convertFilePartToImageUrl(
        { type: 'file', data: undefined, mediaType: 'image/png' }), undefined
      )
    })
  })

  describe('buildTextOutputMessages', () => {
    it('should append assistant text to input messages', () => {
      const input = [{ role: 'user', content: 'Hello' }]
      assert.deepStrictEqual(buildTextOutputMessages(input, 'Hi there'), [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ])
    })

    it('should not mutate input array', () => {
      const input = [{ role: 'user', content: 'Hello' }]
      buildTextOutputMessages(input, 'Hi')
      assert.strictEqual(input.length, 1)
    })
  })

  describe('buildToolCallOutputMessages', () => {
    it('should append tool calls using args field', () => {
      const input = [{ role: 'user', content: 'Delete it' }]
      const toolCalls = [{
        toolCallId: 'call_1',
        toolName: 'deleteUser',
        args: { userId: '123' },
      }]
      assert.deepStrictEqual(buildToolCallOutputMessages(input, toolCalls), [
        { role: 'user', content: 'Delete it' },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_1',
            function: { name: 'deleteUser', arguments: '{"userId":"123"}' },
          }],
        },
      ])
    })

    it('should append tool calls using input field', () => {
      const input = [{ role: 'user', content: 'Delete it' }]
      const toolCalls = [{
        toolCallId: 'call_1',
        toolName: 'deleteUser',
        input: { userId: '123' },
      }]
      assert.deepStrictEqual(buildToolCallOutputMessages(input, toolCalls), [
        { role: 'user', content: 'Delete it' },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_1',
            function: { name: 'deleteUser', arguments: '{"userId":"123"}' },
          }],
        },
      ])
    })

    it('should prefer args over input when both present', () => {
      const input = [{ role: 'user', content: 'Do it' }]
      const toolCalls = [{
        toolCallId: 'call_1',
        toolName: 'action',
        args: { from: 'args' },
        input: { from: 'input' },
      }]
      const result = buildToolCallOutputMessages(input, toolCalls)
      assert.strictEqual(result[1].tool_calls[0].function.arguments, '{"from":"args"}')
    })

    it('should handle string args', () => {
      const input = [{ role: 'user', content: 'Do it' }]
      const toolCalls = [{
        toolCallId: 'call_1',
        toolName: 'action',
        args: '{"raw":"string"}',
      }]
      const result = buildToolCallOutputMessages(input, toolCalls)
      assert.strictEqual(result[1].tool_calls[0].function.arguments, '{"raw":"string"}')
    })
  })

  describe('buildOutputMessages', () => {
    const input = [{ role: 'user', content: 'Hello' }]

    it('should build text output messages for text content', () => {
      const content = [{ type: 'text', text: 'Hi there' }]
      assert.deepStrictEqual(buildOutputMessages(input, content), [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ])
    })

    it('should join multiple text parts', () => {
      const content = [
        { type: 'text', text: 'Line 1' },
        { type: 'text', text: 'Line 2' },
      ]
      assert.deepStrictEqual(buildOutputMessages(input, content), [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Line 1\nLine 2' },
      ])
    })

    it('should build tool call output messages for tool-call content', () => {
      const content = [{
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'search',
        args: { q: 'test' },
      }]
      assert.deepStrictEqual(buildOutputMessages(input, content), [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_1',
            function: { name: 'search', arguments: '{"q":"test"}' },
          }],
        },
      ])
    })

    it('should prefer tool calls over text when both present', () => {
      const content = [
        { type: 'text', text: 'Some text' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'action', args: {} },
      ]
      const result = buildOutputMessages(input, content)
      assert.strictEqual(result[1].role, 'assistant')
      assert.ok(result[1].tool_calls)
    })

    it('should return input messages unchanged for empty content', () => {
      assert.deepStrictEqual(buildOutputMessages(input, []), input)
    })

    it('should return input messages for content with no text or tool-calls', () => {
      const content = [{ type: 'image', data: '...' }]
      assert.deepStrictEqual(buildOutputMessages(input, content), input)
    })
  })

  describe('convertOpenAIResponseItemsToMessages', () => {
    it('should convert string input to a default role message', () => {
      assert.deepStrictEqual(convertOpenAIResponseItemsToMessages('Hello', 'user'), [
        { role: 'user', content: 'Hello' },
      ])
    })

    it('should return empty array for unsupported input', () => {
      assert.deepStrictEqual(convertOpenAIResponseItemsToMessages(undefined, 'user'), [])
      assert.deepStrictEqual(convertOpenAIResponseItemsToMessages({ input: 'Hello' }, 'user'), [])
    })

    it('should convert response message items to OpenAI chat-style messages', () => {
      const items = [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }],
      }]

      assert.deepStrictEqual(convertOpenAIResponseItemsToMessages(items, 'user'), [
        { role: 'user', content: 'Hello' },
      ])
    })

    it('should use the default role when response message item has no role', () => {
      const items = [{
        type: 'message',
        content: [{ type: 'output_text', text: 'Hi' }],
      }]

      assert.deepStrictEqual(convertOpenAIResponseItemsToMessages(items, 'assistant'), [
        { role: 'assistant', content: 'Hi' },
      ])
    })

    it('should preserve image URL content parts', () => {
      const items = [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe this' },
          { type: 'input_image', image_url: 'https://example.com/image.png' },
        ],
      }]

      assert.deepStrictEqual(convertOpenAIResponseItemsToMessages(items, 'user'), [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
        ],
      }])
    })

    it('should convert function call items to assistant tool call messages', () => {
      const items = [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: { query: 'test' },
      }]

      assert.deepStrictEqual(convertOpenAIResponseItemsToMessages(items, 'assistant'), [{
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          function: {
            name: 'lookup',
            arguments: '{"query":"test"}',
          },
        }],
      }])
    })

    it('should convert function call output items to tool messages', () => {
      const items = [{
        type: 'function_call_output',
        call_id: 'call_1',
        output: { result: 'ok' },
      }]

      assert.deepStrictEqual(convertOpenAIResponseItemsToMessages(items, 'tool'), [{
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"result":"ok"}',
      }])
    })

    it('should JSON-stringify function_call arguments when given as an object', () => {
      const items = [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: { query: 'test', limit: 5 },
      }]

      assert.deepStrictEqual(convertOpenAIResponseItemsToMessages(items, 'assistant'), [{
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          function: { name: 'lookup', arguments: '{"query":"test","limit":5}' },
        }],
      }])
    })

    it('should treat a message item with no `type` as a regular message', () => {
      const items = [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }]
      assert.deepStrictEqual(convertOpenAIResponseItemsToMessages(items, 'user'), [
        { role: 'user', content: 'Hi' },
      ])
    })

    it('should drop unknown item types without throwing', () => {
      const items = [
        { type: 'reasoning', summary: 'thinking' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
      ]
      assert.deepStrictEqual(convertOpenAIResponseItemsToMessages(items, 'user'), [
        { role: 'user', content: 'Hi' },
      ])
    })
  })

  describe('openAIResponseContentToMessageContent', () => {
    it('should return string content unchanged', () => {
      assert.strictEqual(openAIResponseContentToMessageContent('Hello'), 'Hello')
    })

    it('should join text-only parts', () => {
      const content = [
        { type: 'input_text', text: 'Line 1' },
        { type: 'output_text', text: 'Line 2' },
      ]

      assert.strictEqual(openAIResponseContentToMessageContent(content), 'Line 1\nLine 2')
    })

    it('should return text and image parts when image content is present', () => {
      const content = [
        'Look at this',
        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
      ]

      assert.deepStrictEqual(openAIResponseContentToMessageContent(content), [
        { type: 'text', text: 'Look at this' },
        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
      ])
    })

    it('should return undefined for unsupported content', () => {
      assert.strictEqual(openAIResponseContentToMessageContent(undefined), undefined)
      assert.strictEqual(openAIResponseContentToMessageContent([{ type: 'refusal', text: 'No' }]), undefined)
    })

    it('should drop image parts with an empty-string url', () => {
      // Regression for the `??` fix at openAIResponseContentToMessageContent: with `||`, an
      // empty-string `image_url.url` would have wrongly fallen through to `part.url`.
      const content = [
        { type: 'input_text', text: 'Hi' },
        { type: 'input_image', image_url: { url: '' }, url: 'https://wrong-fallback.test' },
      ]
      assert.strictEqual(openAIResponseContentToMessageContent(content), 'Hi')
    })

    it('should keep known parts and drop unknown parts in mixed content', () => {
      const content = [
        { type: 'input_text', text: 'Look at this' },
        { type: 'unknown_future_part', payload: 'ignored' },
        { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
      ]
      assert.deepStrictEqual(openAIResponseContentToMessageContent(content), [
        { type: 'text', text: 'Look at this' },
        { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
      ])
    })

    it('should return undefined for content with only refusal-like parts (documents v1 limitation)', () => {
      // v1 of the converter does not lift `refusal` parts into AI Guard content.
      // This is acceptable for chat.completions because refusal is at the message
      // level (handled by getOutputMessages); for responses, refusal-only output
      // items currently surface no AI Guard input.
      const content = [{ type: 'refusal', refusal: 'I cannot help with that' }]
      assert.strictEqual(openAIResponseContentToMessageContent(content), undefined)
    })

    it('should drop null entries in the content array without throwing', () => {
      const content = [null, { type: 'input_text', text: 'Hi' }, undefined]
      assert.strictEqual(openAIResponseContentToMessageContent(content), 'Hi')
    })
  })
})
