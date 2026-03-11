'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const {
  convertToAIGuardFormat,
  convertToolCallPart,
} = require('../../src/aiguard/convert')

describe('AI Guard Convert', () => {
  describe('convertToolCallPart', () => {
    it('normalizes argument sources', () => {
      const cases = [
        {
          title: 'object input from prompt tool calls',
          toolCallPart: {
            toolCallId: 'call_1',
            toolName: 'lookupWeather',
            input: { city: 'Tokyo' },
          },
          expected: createToolCall('call_1', 'lookupWeather', '{"city":"Tokyo"}'),
        },
        {
          title: 'string input from stream tool calls',
          toolCallPart: {
            toolCallId: 'call_2',
            toolName: 'lookupWeather',
            input: '{"city":"Tokyo"}',
          },
          expected: createToolCall('call_2', 'lookupWeather', '{"city":"Tokyo"}'),
        },
        {
          title: 'function.arguments from OpenAI-compatible shape',
          toolCallPart: {
            id: 'call_3',
            function: {
              name: 'lookupWeather',
              arguments: '{"city":"Tokyo"}',
            },
          },
          expected: createToolCall('call_3', 'lookupWeather', '{"city":"Tokyo"}'),
        },
        {
          title: 'top-level arguments string',
          toolCallPart: {
            toolCallId: 'call_4',
            toolName: 'lookupWeather',
            arguments: '{"city":"Tokyo"}',
          },
          expected: createToolCall('call_4', 'lookupWeather', '{"city":"Tokyo"}'),
        },
        {
          title: 'missing argument sources',
          toolCallPart: {
            toolCallId: 'call_5',
            toolName: 'lookupWeather',
          },
          expected: createToolCall('call_5', 'lookupWeather', '{}'),
        },
        {
          title: 'empty object input',
          toolCallPart: {
            toolCallId: 'call_6',
            toolName: 'lookupWeather',
            input: {},
          },
          expected: createToolCall('call_6', 'lookupWeather', '{}'),
        },
        {
          title: 'null args object',
          toolCallPart: {
            toolCallId: 'call_7',
            toolName: 'lookupWeather',
            args: null,
          },
          expected: createToolCall('call_7', 'lookupWeather', '{}'),
        },
        {
          title: 'JSON null arguments string',
          toolCallPart: {
            toolCallId: 'call_8',
            toolName: 'lookupWeather',
            args: 'null',
          },
          expected: createToolCall('call_8', 'lookupWeather', '{}'),
        },
        {
          title: 'JSON array arguments string',
          toolCallPart: {
            toolCallId: 'call_9',
            toolName: 'lookupWeather',
            args: '[1,2,3]',
          },
          expected: createToolCall('call_9', 'lookupWeather', '{}'),
        },
        {
          title: 'empty input string',
          toolCallPart: {
            toolCallId: 'call_10',
            toolName: 'lookupWeather',
            input: '',
          },
          expected: createToolCall('call_10', 'lookupWeather', '{}'),
        },
      ]

      for (const { title, toolCallPart, expected } of cases) {
        assert.deepStrictEqual(convertToolCallPart(toolCallPart), expected, title)
      }
    })

    it('wraps broken JSON strings with _raw', () => {
      const result = convertToolCallPart({
        toolCallId: 'call_1',
        toolName: 'lookupWeather',
        input: '{"city":}',
      })

      assert.deepStrictEqual(
        result,
        createToolCall('call_1', 'lookupWeather', '{"_raw":"{\\"city\\":}"}')
      )
    })

    it('applies field precedence for ids, names, and argument sources', () => {
      const cases = [
        {
          title: 'input wins over args',
          toolCallPart: {
            toolCallId: 'call_1',
            toolName: 'lookupWeather',
            input: { city: 'Tokyo' },
            args: { city: 'Osaka' },
          },
          expected: createToolCall('call_1', 'lookupWeather', '{"city":"Tokyo"}'),
        },
        {
          title: 'args wins over function.arguments',
          toolCallPart: {
            id: 'call_2',
            args: { city: 'Tokyo' },
            function: {
              name: 'lookupWeather',
              arguments: '{"city":"Osaka"}',
            },
          },
          expected: createToolCall('call_2', 'lookupWeather', '{"city":"Tokyo"}'),
        },
        {
          title: 'empty input object still wins over args',
          toolCallPart: {
            toolCallId: 'call_3',
            toolName: 'lookupWeather',
            input: {},
            args: { city: 'Osaka' },
          },
          expected: createToolCall('call_3', 'lookupWeather', '{}'),
        },
        {
          title: 'toolCallId wins over id',
          toolCallPart: {
            toolCallId: 'tool-call-id',
            id: 'fallback-id',
            toolName: 'lookupWeather',
          },
          expected: createToolCall('tool-call-id', 'lookupWeather', '{}'),
        },
        {
          title: 'id is used when toolCallId is absent',
          toolCallPart: {
            id: 'fallback-id',
            toolName: 'lookupWeather',
          },
          expected: createToolCall('fallback-id', 'lookupWeather', '{}'),
        },
        {
          title: 'toolName wins over function.name',
          toolCallPart: {
            toolCallId: 'call_4',
            toolName: 'preferredTool',
            function: {
              name: 'fallbackTool',
            },
          },
          expected: createToolCall('call_4', 'preferredTool', '{}'),
        },
        {
          title: 'function.name is used when toolName is absent',
          toolCallPart: {
            toolCallId: 'call_5',
            function: {
              name: 'fallbackTool',
            },
          },
          expected: createToolCall('call_5', 'fallbackTool', '{}'),
        },
        {
          title: 'name is used when toolName and function.name are absent',
          toolCallPart: {
            id: 'call_6',
            name: 'finalFallbackTool',
          },
          expected: createToolCall('call_6', 'finalFallbackTool', '{}'),
        },
      ]

      for (const { title, toolCallPart, expected } of cases) {
        assert.deepStrictEqual(convertToolCallPart(toolCallPart), expected, title)
      }
    })

    it('rejects invalid ids', () => {
      const cases = [
        { title: 'missing', toolCallPart: { toolName: 'lookupWeather' } },
        { title: 'empty string', toolCallPart: { toolCallId: '', toolName: 'lookupWeather' } },
        { title: 'whitespace only', toolCallPart: { toolCallId: '   ', toolName: 'lookupWeather' } },
        { title: 'non-string', toolCallPart: { toolCallId: 123, toolName: 'lookupWeather' } },
      ]

      for (const { title, toolCallPart } of cases) {
        assert.throws(
          () => convertToolCallPart(toolCallPart),
          { name: 'TypeError', message: 'Tool call ID must be a non-empty string' },
          title
        )
      }
    })

    it('rejects invalid names', () => {
      const cases = [
        { title: 'missing', toolCallPart: { toolCallId: 'call_1' } },
        { title: 'empty string', toolCallPart: { toolCallId: 'call_1', toolName: '' } },
        { title: 'whitespace only', toolCallPart: { toolCallId: 'call_1', toolName: '   ' } },
        { title: 'non-string', toolCallPart: { toolCallId: 'call_1', toolName: 123 } },
      ]

      for (const { title, toolCallPart } of cases) {
        assert.throws(
          () => convertToolCallPart(toolCallPart),
          { name: 'TypeError', message: 'Tool call name must be a non-empty string' },
          title
        )
      }
    })
  })

  describe('convertToAIGuardFormat', () => {
    it('converts basic message shapes', () => {
      const cases = [
        {
          title: 'system message',
          prompt: [{ role: 'system', content: 'You are a helpful assistant' }],
          expected: [{ role: 'system', content: 'You are a helpful assistant' }],
        },
        {
          title: 'user message with string content',
          prompt: [{ role: 'user', content: 'Hello!' }],
          expected: [{ role: 'user', content: 'Hello!' }],
        },
        {
          title: 'user message with text-part array',
          prompt: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Hello, ' },
              { type: 'text', text: 'how are you?' },
            ],
          }],
          expected: [{ role: 'user', content: 'Hello, how are you?' }],
        },
        {
          title: 'user message skips non-text parts',
          prompt: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Hello' },
              { type: 'image', image: 'base64...' },
              { type: 'text', text: ' world' },
            ],
          }],
          expected: [{ role: 'user', content: 'Hello world' }],
        },
        {
          title: 'user message with empty content array',
          prompt: [{ role: 'user', content: [] }],
          expected: [{ role: 'user', content: '' }],
        },
        {
          title: 'user message with missing text properties',
          prompt: [{
            role: 'user',
            content: [
              { type: 'text' },
              { type: 'text', text: 'Hello' },
            ],
          }],
          expected: [{ role: 'user', content: 'Hello' }],
        },
        {
          title: 'assistant message with text parts',
          prompt: [{
            role: 'assistant',
            content: [{ type: 'text', text: 'I am fine, thank you!' }],
          }],
          expected: [{ role: 'assistant', content: 'I am fine, thank you!' }],
        },
        {
          title: 'assistant message with non-array content',
          prompt: [{ role: 'assistant', content: 'Simple text response' }],
          expected: [{ role: 'assistant', content: 'Simple text response' }],
        },
        {
          title: 'empty prompt',
          prompt: [],
          expected: [],
        },
      ]

      for (const { title, prompt, expected } of cases) {
        assert.deepStrictEqual(convertToAIGuardFormat(prompt), expected, title)
      }
    })

    it('preserves assistant text alongside tool calls', () => {
      const result = convertToAIGuardFormat([{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check the weather for you.' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'lookupWeather',
            args: { city: 'Tokyo' },
          },
        ],
      }])

      assert.deepStrictEqual(result, [{
        role: 'assistant',
        content: 'Let me check the weather for you.',
        tool_calls: [
          createToolCall('call_1', 'lookupWeather', '{"city":"Tokyo"}'),
        ],
      }])
    })

    it('converts multiple assistant tool calls', () => {
      const result = convertToAIGuardFormat([{
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'lookupWeather',
            args: { city: 'Tokyo' },
          },
          {
            type: 'tool-call',
            toolCallId: 'call_2',
            toolName: 'lookupTime',
            args: { timezone: 'Asia/Tokyo' },
          },
        ],
      }])

      assert.deepStrictEqual(result, [{
        role: 'assistant',
        content: '',
        tool_calls: [
          createToolCall('call_1', 'lookupWeather', '{"city":"Tokyo"}'),
          createToolCall('call_2', 'lookupTime', '{"timezone":"Asia/Tokyo"}'),
        ],
      }])
    })

    it('converts tool-result outputs', () => {
      const cases = [
        {
          title: 'text output',
          output: { type: 'text', value: 'Weather is sunny' },
          expectedContent: 'Weather is sunny',
        },
        {
          title: 'json output',
          output: { type: 'json', value: { temperature: 20, condition: 'sunny' } },
          expectedContent: '{"temperature":20,"condition":"sunny"}',
        },
        {
          title: 'error-text output',
          output: { type: 'error-text', value: 'API rate limit exceeded' },
          expectedContent: 'API rate limit exceeded',
        },
        {
          title: 'error-json output',
          output: { type: 'error-json', value: { code: 429, message: 'Rate limited' } },
          expectedContent: '{"code":429,"message":"Rate limited"}',
        },
        {
          title: 'execution-denied output with reason',
          output: { type: 'execution-denied', reason: 'User denied execution' },
          expectedContent: 'User denied execution',
        },
        {
          title: 'execution-denied output without reason',
          output: { type: 'execution-denied' },
          expectedContent: '',
        },
        {
          title: 'content output extracts text parts',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'Found result: ' },
              { type: 'image-data', data: 'base64...', mediaType: 'image/png' },
              { type: 'text', text: 'Tokyo weather is sunny' },
            ],
          },
          expectedContent: 'Found result: Tokyo weather is sunny',
        },
        {
          title: 'missing output',
          output: undefined,
          expectedContent: '',
        },
      ]

      for (const { title, output, expectedContent } of cases) {
        assert.deepStrictEqual(
          convertToAIGuardFormat([createToolResultMessage('call_1', output)]),
          [createToolMessage('call_1', expectedContent)],
          title
        )
      }
    })

    it('flattens multiple tool results into separate messages', () => {
      const result = convertToAIGuardFormat([{
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'lookupWeather',
            output: { type: 'text', value: 'Weather is sunny' },
          },
          {
            type: 'tool-result',
            toolCallId: 'call_2',
            toolName: 'lookupTime',
            output: { type: 'text', value: 'Time is 3:00 PM' },
          },
        ],
      }])

      assert.deepStrictEqual(result, [
        createToolMessage('call_1', 'Weather is sunny'),
        createToolMessage('call_2', 'Time is 3:00 PM'),
      ])
    })

    it('converts a full conversation end-to-end', () => {
      const result = convertToAIGuardFormat([
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'What is the weather in Tokyo?' },
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'lookupWeather',
            args: { city: 'Tokyo' },
          }],
        },
        createToolResultMessage('call_1', {
          type: 'json',
          value: { temperature: 20, condition: 'sunny' },
        }),
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'The weather in Tokyo is sunny with 20°C.' }],
        },
      ])

      assert.deepStrictEqual(result, [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'What is the weather in Tokyo?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            createToolCall('call_1', 'lookupWeather', '{"city":"Tokyo"}'),
          ],
        },
        createToolMessage('call_1', '{"temperature":20,"condition":"sunny"}'),
        { role: 'assistant', content: 'The weather in Tokyo is sunny with 20°C.' },
      ])
    })
  })
})

function createToolCall (id, name, argumentsString) {
  return {
    id,
    function: {
      name,
      arguments: argumentsString,
    },
  }
}

function createToolMessage (toolCallId, content) {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content,
  }
}

function createToolResultMessage (toolCallId, output) {
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId,
      toolName: 'lookupWeather',
      output,
    }],
  }
}
