'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const {
  convertToAIGuardFormat,
  convertToolCallPart,
} = require('../../../src/aiguard/middleware/convert')

describe('AI Guard Middleware Convert', () => {
  describe('convertToolCallPart', () => {
    // Basic conversion tests
    it('should convert tool call part with input as object (LanguageModelV3ToolCallPart in prompt)', () => {
      const toolCallPart = {
        type: 'tool-call',
        toolCallId: 'call_123',
        toolName: 'getWeather',
        input: { city: 'Tokyo' },
      }

      const result = convertToolCallPart(toolCallPart)

      assert.deepStrictEqual(result, {
        id: 'call_123',
        function: {
          name: 'getWeather',
          arguments: '{"city":"Tokyo"}',
        },
      })
    })

    it('should convert tool call part with input as string (LanguageModelV3ToolCall in result/stream)', () => {
      const toolCallPart = {
        type: 'tool-call',
        toolCallId: 'call_123',
        toolName: 'getWeather',
        input: '{"city":"Tokyo"}',
      }

      const result = convertToolCallPart(toolCallPart)

      assert.deepStrictEqual(result, {
        id: 'call_123',
        function: {
          name: 'getWeather',
          arguments: '{"city":"Tokyo"}',
        },
      })
    })

    it('should normalize broken JSON when input is string', () => {
      const toolCallPart = {
        type: 'tool-call',
        toolCallId: 'call_123',
        toolName: 'getWeather',
        input: '{"city":}',
      }

      const result = convertToolCallPart(toolCallPart)

      assert.deepStrictEqual(result, {
        id: 'call_123',
        function: {
          name: 'getWeather',
          arguments: '{"_raw":"{\\"city\\":}"}',
        },
      })
    })

    it('should return {} when input is empty string', () => {
      const toolCallPart = {
        type: 'tool-call',
        toolCallId: 'call_123',
        toolName: 'getWeather',
        input: '',
      }

      const result = convertToolCallPart(toolCallPart)

      assert.deepStrictEqual(result, {
        id: 'call_123',
        function: {
          name: 'getWeather',
          arguments: '{}',
        },
      })
    })

    it('should convert function.arguments format (OpenAI compatible)', () => {
      const toolCallPart = {
        id: 'call_789',
        function: {
          name: 'test',
          arguments: '{"foo":"bar"}',
        },
      }

      const result = convertToolCallPart(toolCallPart)

      assert.deepStrictEqual(result, {
        id: 'call_789',
        function: {
          name: 'test',
          arguments: '{"foo":"bar"}',
        },
      })
    })

    it('should convert top-level arguments field', () => {
      const toolCallPart = {
        toolCallId: 'call_1',
        toolName: 'test',
        arguments: '{"foo":"bar"}',
      }

      const result = convertToolCallPart(toolCallPart)

      assert.deepStrictEqual(result, {
        id: 'call_1',
        function: {
          name: 'test',
          arguments: '{"foo":"bar"}',
        },
      })
    })

    it('should return {} when all argument fields are undefined', () => {
      const toolCallPart = {
        toolCallId: 'call_1',
        toolName: 'test',
      }

      const result = convertToolCallPart(toolCallPart)

      assert.deepStrictEqual(result, {
        id: 'call_1',
        function: {
          name: 'test',
          arguments: '{}',
        },
      })
    })

    // Empty/null argument edge cases - consolidated to representative cases
    const emptyArgsCases = [
      { desc: 'input is empty object', field: 'input', value: {} },
      { desc: 'args is null', field: 'args', value: null },
    ]

    for (const { desc, field, value } of emptyArgsCases) {
      it(`should return {} when ${desc}`, () => {
        const toolCallPart = {
          toolCallId: 'call_1',
          toolName: 'test',
          [field]: value,
        }

        const result = convertToolCallPart(toolCallPart)

        assert.deepStrictEqual(result, {
          id: 'call_1',
          function: {
            name: 'test',
            arguments: '{}',
          },
        })
      })
    }

    // JSON primitives (non-object) should return {} - consolidated to representative cases
    const jsonPrimitiveCases = [
      { desc: 'JSON null', value: 'null' },
      { desc: 'JSON array', value: '[1,2,3]' },
    ]

    for (const { desc, value } of jsonPrimitiveCases) {
      it(`should return {} when args is ${desc}`, () => {
        const toolCallPart = {
          toolCallId: 'call_1',
          toolName: 'test',
          args: value,
        }

        const result = convertToolCallPart(toolCallPart)

        assert.deepStrictEqual(result, {
          id: 'call_1',
          function: {
            name: 'test',
            arguments: '{}',
          },
        })
      })
    }

    // Priority tests
    it('should prioritize input over args', () => {
      const toolCallPart = {
        toolCallId: 'call_1',
        toolName: 'test',
        input: { a: 1 },
        args: { b: 2 },
      }

      const result = convertToolCallPart(toolCallPart)

      assert.deepStrictEqual(result, {
        id: 'call_1',
        function: {
          name: 'test',
          arguments: '{"a":1}',
        },
      })
    })

    it('should prioritize args over function.arguments', () => {
      const toolCallPart = {
        id: 'call_1',
        args: { a: 1 },
        function: {
          name: 'test',
          arguments: '{"b":2}',
        },
      }

      const result = convertToolCallPart(toolCallPart)

      assert.deepStrictEqual(result, {
        id: 'call_1',
        function: {
          name: 'test',
          arguments: '{"a":1}',
        },
      })
    })

    it('should prioritize empty input object over args', () => {
      const toolCallPart = {
        toolCallId: 'call_1',
        toolName: 'test',
        input: {},
        args: { b: 2 },
      }

      const result = convertToolCallPart(toolCallPart)

      assert.deepStrictEqual(result, {
        id: 'call_1',
        function: {
          name: 'test',
          arguments: '{}',
        },
      })
    })

    // ID field tests
    it('should prioritize toolCallId over id', () => {
      const toolCallPart = {
        toolCallId: 'tc1',
        id: 'id1',
        toolName: 'test',
      }

      const result = convertToolCallPart(toolCallPart)

      assert.strictEqual(result.id, 'tc1')
    })

    it('should fallback to id when toolCallId is not present', () => {
      const toolCallPart = {
        id: 'id1',
        toolName: 'test',
      }

      const result = convertToolCallPart(toolCallPart)

      assert.strictEqual(result.id, 'id1')
    })

    // ID validation - parameterized
    const invalidIdCases = [
      { desc: 'missing', input: { toolName: 'test' } },
      { desc: 'empty string', input: { toolCallId: '', toolName: 'test' } },
      { desc: 'whitespace only', input: { toolCallId: '   ', toolName: 'test' } },
      { desc: 'number', input: { toolCallId: 123, toolName: 'test' } },
    ]

    for (const { desc, input } of invalidIdCases) {
      it(`should throw TypeError when id is ${desc}`, () => {
        assert.throws(
          () => convertToolCallPart(input),
          { name: 'TypeError', message: 'Tool call ID must be a non-empty string' }
        )
      })
    }

    // Name field tests
    it('should prioritize toolName over function.name', () => {
      const toolCallPart = {
        toolCallId: 'call_1',
        toolName: 'tn',
        function: { name: 'fn' },
      }

      const result = convertToolCallPart(toolCallPart)

      assert.strictEqual(result.function.name, 'tn')
    })

    it('should fallback to function.name when toolName is not present', () => {
      const toolCallPart = {
        id: 'call_1',
        function: { name: 'fn' },
      }

      const result = convertToolCallPart(toolCallPart)

      assert.strictEqual(result.function.name, 'fn')
    })

    it('should fallback to name when toolName and function.name are not present', () => {
      const toolCallPart = {
        id: 'call_1',
        name: 'n',
      }

      const result = convertToolCallPart(toolCallPart)

      assert.strictEqual(result.function.name, 'n')
    })

    // Name validation - parameterized
    const invalidNameCases = [
      { desc: 'missing', input: { toolCallId: 'call_1' } },
      { desc: 'empty string', input: { toolCallId: 'call_1', toolName: '' } },
      { desc: 'whitespace only', input: { toolCallId: 'call_1', toolName: '   ' } },
      { desc: 'number', input: { toolCallId: 'call_1', toolName: 123 } },
    ]

    for (const { desc, input } of invalidNameCases) {
      it(`should throw TypeError when name is ${desc}`, () => {
        assert.throws(
          () => convertToolCallPart(input),
          { name: 'TypeError', message: 'Tool call name must be a non-empty string' }
        )
      })
    }
  })

  describe('convertToAIGuardFormat', () => {
    it('should convert system message', () => {
      const prompt = [
        { role: 'system', content: 'You are a helpful assistant' },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'system', content: 'You are a helpful assistant' },
      ])
    })

    it('should convert user message with string content', () => {
      const prompt = [
        { role: 'user', content: 'Hello!' },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'user', content: 'Hello!' },
      ])
    })

    it('should convert user message with array content', () => {
      const prompt = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello, ' },
            { type: 'text', text: 'how are you?' },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'user', content: 'Hello, how are you?' },
      ])
    })

    it('should convert assistant message with text content', () => {
      const prompt = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I am fine, thank you!' },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'assistant', content: 'I am fine, thank you!' },
      ])
    })

    it('should convert assistant message with tool calls', () => {
      const prompt = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'getWeather',
              args: { city: 'Tokyo' },
            },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              function: {
                name: 'getWeather',
                arguments: '{"city":"Tokyo"}',
              },
            },
          ],
        },
      ])
    })

    it('should convert assistant message with multiple tool calls', () => {
      const prompt = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'getWeather',
              args: { city: 'Tokyo' },
            },
            {
              type: 'tool-call',
              toolCallId: 'call_2',
              toolName: 'getTime',
              args: { timezone: 'Asia/Tokyo' },
            },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              function: {
                name: 'getWeather',
                arguments: '{"city":"Tokyo"}',
              },
            },
            {
              id: 'call_2',
              function: {
                name: 'getTime',
                arguments: '{"timezone":"Asia/Tokyo"}',
              },
            },
          ],
        },
      ])
    })

    it('should preserve text content alongside tool calls in assistant message', () => {
      const prompt = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check the weather for you.' },
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'getWeather',
              args: { city: 'Tokyo' },
            },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        {
          role: 'assistant',
          content: 'Let me check the weather for you.',
          tool_calls: [
            {
              id: 'call_1',
              function: {
                name: 'getWeather',
                arguments: '{"city":"Tokyo"}',
              },
            },
          ],
        },
      ])
    })

    it('should convert tool result with text output', () => {
      const prompt = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'getWeather',
              output: { type: 'text', value: 'Weather is sunny' },
            },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'tool', tool_call_id: 'call_1', content: 'Weather is sunny' },
      ])
    })

    it('should convert tool result with json output', () => {
      const prompt = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'getWeather',
              output: { type: 'json', value: { temperature: 20, condition: 'sunny' } },
            },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: '{"temperature":20,"condition":"sunny"}',
        },
      ])
    })

    it('should convert tool result with error-text output', () => {
      const prompt = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'getWeather',
              output: { type: 'error-text', value: 'API rate limit exceeded' },
            },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'tool', tool_call_id: 'call_1', content: 'API rate limit exceeded' },
      ])
    })

    it('should convert tool result with error-json output', () => {
      const prompt = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'getWeather',
              output: { type: 'error-json', value: { code: 429, message: 'Rate limited' } },
            },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: '{"code":429,"message":"Rate limited"}',
        },
      ])
    })

    it('should convert tool result with execution-denied output', () => {
      const prompt = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'dangerousOp',
              output: { type: 'execution-denied', reason: 'User denied execution' },
            },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'tool', tool_call_id: 'call_1', content: 'User denied execution' },
      ])
    })

    it('should convert tool result with execution-denied output without reason', () => {
      const prompt = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'dangerousOp',
              output: { type: 'execution-denied' },
            },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'tool', tool_call_id: 'call_1', content: '' },
      ])
    })

    it('should convert tool result with content output (extract text parts)', () => {
      const prompt = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'search',
              output: {
                type: 'content',
                value: [
                  { type: 'text', text: 'Found result: ' },
                  { type: 'image-data', data: 'base64...', mediaType: 'image/png' },
                  { type: 'text', text: 'Tokyo weather is sunny' },
                ],
              },
            },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'tool', tool_call_id: 'call_1', content: 'Found result: Tokyo weather is sunny' },
      ])
    })

    it('should handle tool result with missing output gracefully', () => {
      const prompt = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'test',
            },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'tool', tool_call_id: 'call_1', content: '' },
      ])
    })

    it('should convert multiple tool results into separate messages', () => {
      const prompt = [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'getWeather',
              output: { type: 'text', value: 'Weather is sunny' },
            },
            {
              type: 'tool-result',
              toolCallId: 'call_2',
              toolName: 'getTime',
              output: { type: 'text', value: 'Time is 3:00 PM' },
            },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'tool', tool_call_id: 'call_1', content: 'Weather is sunny' },
        { role: 'tool', tool_call_id: 'call_2', content: 'Time is 3:00 PM' },
      ])
    })

    it('should convert full conversation', () => {
      const prompt = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'What is the weather in Tokyo?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'getWeather',
              args: { city: 'Tokyo' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'getWeather',
              output: { type: 'json', value: { temperature: 20, condition: 'sunny' } },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'The weather in Tokyo is sunny with 20°C.' },
          ],
        },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'What is the weather in Tokyo?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              function: {
                name: 'getWeather',
                arguments: '{"city":"Tokyo"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: '{"temperature":20,"condition":"sunny"}',
        },
        { role: 'assistant', content: 'The weather in Tokyo is sunny with 20°C.' },
      ])
    })

    it('should handle assistant message with non-array content', () => {
      const prompt = [
        { role: 'assistant', content: 'Simple text response' },
      ]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'assistant', content: 'Simple text response' },
      ])
    })

    it('should handle empty prompt', () => {
      const result = convertToAIGuardFormat([])
      assert.deepStrictEqual(result, [])
    })

    // Text content extraction edge cases (previously tested via extractTextContent)
    it('should skip non-text parts in user message content', () => {
      const prompt = [{
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image', image: 'base64...' },
          { type: 'text', text: ' world' },
        ],
      }]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'user', content: 'Hello world' },
      ])
    })

    it('should handle empty content array in user message', () => {
      const prompt = [{ role: 'user', content: [] }]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'user', content: '' },
      ])
    })

    it('should handle content parts without text property', () => {
      const prompt = [{
        role: 'user',
        content: [
          { type: 'text' },
          { type: 'text', text: 'Hello' },
        ],
      }]

      const result = convertToAIGuardFormat(prompt)

      assert.deepStrictEqual(result, [
        { role: 'user', content: 'Hello' },
      ])
    })
  })
})
