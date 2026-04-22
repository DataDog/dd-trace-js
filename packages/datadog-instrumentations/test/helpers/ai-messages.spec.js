'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const {
  convertVercelPromptToMessages,
  convertFilePartToImageUrl,
  buildOutputMessages,
  buildTextOutputMessages,
  buildToolCallOutputMessages,
  convertChatCompletionMessages,
  buildChatCompletionOutputMessages,
  convertResponsesInput,
  buildResponsesOutputMessages,
  normalizeResponsesContent,
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

  describe('convertChatCompletionMessages', () => {
    it('returns empty array for non-array input', () => {
      assert.deepStrictEqual(convertChatCompletionMessages(null), [])
      assert.deepStrictEqual(convertChatCompletionMessages(undefined), [])
      assert.deepStrictEqual(convertChatCompletionMessages('string'), [])
    })

    it('skips entries without a role', () => {
      assert.deepStrictEqual(convertChatCompletionMessages([{ content: 'x' }, null, 42]), [])
    })

    it('passes through system, user, assistant messages', () => {
      const messages = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ]
      assert.deepStrictEqual(convertChatCompletionMessages(messages), messages)
    })

    it('preserves tool_calls and tool_call_id', () => {
      const tc = { id: 'c1', function: { name: 'search', arguments: '{}' } }
      const messages = [
        { role: 'assistant', tool_calls: [tc] },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ]
      assert.deepStrictEqual(convertChatCompletionMessages(messages), messages)
    })

    it('preserves name when present', () => {
      const messages = [{ role: 'function', name: 'calculator', content: 'result' }]
      assert.deepStrictEqual(convertChatCompletionMessages(messages), messages)
    })

    it('strips unknown fields', () => {
      const messages = [{ role: 'user', content: 'hi', custom: 'drop me', _internal: 1 }]
      assert.deepStrictEqual(convertChatCompletionMessages(messages), [
        { role: 'user', content: 'hi' },
      ])
    })

    it('keeps content when it is an array of parts (multimodal)', () => {
      const parts = [{ type: 'text', text: 'look at this' }, { type: 'image_url', image_url: { url: 'x' } }]
      const messages = [{ role: 'user', content: parts }]
      assert.deepStrictEqual(convertChatCompletionMessages(messages), messages)
    })
  })

  describe('buildChatCompletionOutputMessages', () => {
    const input = [{ role: 'user', content: 'Hi' }]

    it('returns undefined when message is missing', () => {
      assert.strictEqual(buildChatCompletionOutputMessages(input, undefined), undefined)
      assert.strictEqual(buildChatCompletionOutputMessages(input, null), undefined)
    })

    it('returns undefined when message has no content and no tool_calls', () => {
      assert.strictEqual(buildChatCompletionOutputMessages(input, { role: 'assistant' }), undefined)
    })

    it('appends assistant text content', () => {
      const out = buildChatCompletionOutputMessages(input, { role: 'assistant', content: 'Hello!' })
      assert.deepStrictEqual(out, [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ])
    })

    it('defaults role to assistant', () => {
      const out = buildChatCompletionOutputMessages(input, { content: 'Hi' })
      assert.strictEqual(out[1].role, 'assistant')
    })

    it('appends tool_calls', () => {
      const toolCalls = [{ id: 'c1', function: { name: 'search', arguments: '{}' } }]
      const out = buildChatCompletionOutputMessages(input, { role: 'assistant', tool_calls: toolCalls })
      assert.deepStrictEqual(out[1], { role: 'assistant', tool_calls: toolCalls })
    })

    it('keeps empty-string content', () => {
      const out = buildChatCompletionOutputMessages(input, { role: 'assistant', content: '' })
      assert.strictEqual(out[1].content, '')
    })

    it('does not mutate the input messages array', () => {
      const original = [{ role: 'user', content: 'Hi' }]
      buildChatCompletionOutputMessages(original, { role: 'assistant', content: 'Hello!' })
      assert.strictEqual(original.length, 1)
    })
  })

  describe('normalizeResponsesContent', () => {
    it('returns string content as-is', () => {
      assert.strictEqual(normalizeResponsesContent('hello'), 'hello')
    })

    it('returns undefined for non-array non-string', () => {
      assert.strictEqual(normalizeResponsesContent(null), undefined)
      assert.strictEqual(normalizeResponsesContent(undefined), undefined)
      assert.strictEqual(normalizeResponsesContent(42), undefined)
    })

    it('joins input_text and output_text parts', () => {
      const parts = [
        { type: 'input_text', text: 'line 1' },
        { type: 'output_text', text: 'line 2' },
        { type: 'text', text: 'line 3' },
      ]
      assert.strictEqual(normalizeResponsesContent(parts), 'line 1\nline 2\nline 3')
    })

    it('accepts plain strings in a parts array', () => {
      assert.strictEqual(normalizeResponsesContent(['a', 'b']), 'a\nb')
    })

    it('ignores unknown part types', () => {
      const parts = [
        { type: 'input_text', text: 'keep' },
        { type: 'image', image_url: 'drop' },
      ]
      assert.strictEqual(normalizeResponsesContent(parts), 'keep')
    })

    it('returns undefined when nothing normalizes', () => {
      assert.strictEqual(normalizeResponsesContent([{ type: 'image' }]), undefined)
    })
  })

  describe('convertResponsesInput', () => {
    it('converts string shorthand to a single user message', () => {
      assert.deepStrictEqual(convertResponsesInput('what time is it?'), [
        { role: 'user', content: 'what time is it?' },
      ])
    })

    it('returns empty for non-array non-string', () => {
      assert.deepStrictEqual(convertResponsesInput(null), [])
      assert.deepStrictEqual(convertResponsesInput(undefined), [])
      assert.deepStrictEqual(convertResponsesInput(42), [])
    })

    it('defaults missing type to message', () => {
      const input = [{ role: 'user', content: 'hi' }]
      assert.deepStrictEqual(convertResponsesInput(input), [{ role: 'user', content: 'hi' }])
    })

    it('handles message items with typed content parts', () => {
      const input = [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      }]
      assert.deepStrictEqual(convertResponsesInput(input), [{ role: 'user', content: 'hello' }])
    })

    it('converts function_call to an assistant tool_call', () => {
      const input = [{
        type: 'function_call',
        call_id: 'c1',
        name: 'search',
        arguments: '{"q":"test"}',
      }]
      assert.deepStrictEqual(convertResponsesInput(input), [{
        role: 'assistant',
        tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"test"}' } }],
      }])
    })

    it('stringifies function_call object arguments', () => {
      const input = [{
        type: 'function_call',
        call_id: 'c1',
        name: 'search',
        arguments: { q: 'test' },
      }]
      assert.strictEqual(convertResponsesInput(input)[0].tool_calls[0].function.arguments, '{"q":"test"}')
    })

    it('converts function_call_output to a tool message', () => {
      const input = [{
        type: 'function_call_output',
        call_id: 'c1',
        output: 'the result',
      }]
      assert.deepStrictEqual(convertResponsesInput(input), [{
        role: 'tool',
        tool_call_id: 'c1',
        content: 'the result',
      }])
    })

    it('stringifies function_call_output object output', () => {
      const input = [{ type: 'function_call_output', call_id: 'c1', output: { ok: true } }]
      assert.strictEqual(convertResponsesInput(input)[0].content, '{"ok":true}')
    })

    it('skips item_reference and unknown types', () => {
      const input = [
        { type: 'item_reference', id: 'x' },
        { type: 'weird_new_type' },
        { type: 'message', role: 'user', content: 'hi' },
      ]
      assert.deepStrictEqual(convertResponsesInput(input), [{ role: 'user', content: 'hi' }])
    })

    it('skips malformed entries', () => {
      assert.deepStrictEqual(convertResponsesInput([null, 42, { type: 'message' }]), [])
    })
  })

  describe('buildResponsesOutputMessages', () => {
    const input = [{ role: 'user', content: 'Hi' }]

    it('returns undefined for empty or missing output', () => {
      assert.strictEqual(buildResponsesOutputMessages(input, undefined), undefined)
      assert.strictEqual(buildResponsesOutputMessages(input, []), undefined)
      assert.strictEqual(buildResponsesOutputMessages(input, 'not-an-array'), undefined)
    })

    it('returns undefined when output has no known item types', () => {
      assert.strictEqual(
        buildResponsesOutputMessages(input, [{ type: 'reasoning' }, { type: 'image' }]),
        undefined
      )
    })

    it('appends assistant text from message output items', () => {
      const output = [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello!' }],
      }]
      assert.deepStrictEqual(buildResponsesOutputMessages(input, output), [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ])
    })

    it('appends tool calls from function_call output items', () => {
      const output = [{
        type: 'function_call',
        call_id: 'c1',
        name: 'search',
        arguments: '{"q":"a"}',
      }]
      const result = buildResponsesOutputMessages(input, output)
      assert.deepStrictEqual(result[1], {
        role: 'assistant',
        tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"a"}' } }],
      })
    })

    it('appends both text and tool calls in order', () => {
      const output = [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'planning' }] },
        { type: 'function_call', call_id: 'c1', name: 'do', arguments: '{}' },
      ]
      const result = buildResponsesOutputMessages(input, output)
      assert.strictEqual(result.length, 3)
      assert.strictEqual(result[1].content, 'planning')
      assert.ok(result[2].tool_calls)
    })

    it('ignores message items with no normalizable content', () => {
      const output = [{ type: 'message', role: 'assistant', content: [{ type: 'image' }] }]
      assert.strictEqual(buildResponsesOutputMessages(input, output), undefined)
    })
  })
})
