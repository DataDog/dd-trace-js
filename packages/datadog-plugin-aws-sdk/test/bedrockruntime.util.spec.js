'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  extractConverseToolDefinitions,
  extractMessagesFromConverseContent,
  extractRequestParamsConverse,
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

  it('accumulates streamed text, usage and tool input that arrives without a block start', () => {
    const generation = extractTextAndResponseReasonConverseFromStream([
      { messageStart: { role: 'assistant' } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'sunny' } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: ' and warm' } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":"Berlin"}' } } } },
      { metadata: { usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } } },
      { messageStop: { stopReason: 'end_turn' } },
    ])

    assert.strictEqual(generation.finishReason, 'end_turn')
    assert.strictEqual(generation.usage.inputTokens, 3)
    assert.strictEqual(generation.usage.outputTokens, 5)
    assert.deepStrictEqual(generation.messages, [{
      role: 'assistant',
      content: 'sunny and warm',
      toolCalls: [{ name: '', arguments: { city: 'Berlin' }, toolId: '', type: 'toolUse' }],
    }])
  })
})

describe('bedrockruntime converse request extractor', () => {
  it('renders system blocks, messages and tool definitions', () => {
    const params = {
      system: [{ text: 'be brief' }, { guardContent: {} }],
      messages: [
        { content: [{ text: 'hi' }] },
        { role: 'tool', content: [{ toolResult: { toolUseId: 't-1', content: [{ text: '21C' }] } }] },
        { role: 'tool', content: [{ toolResult: { toolUseId: 't-2' } }] },
        null,
      ],
      toolConfig: {
        tools: [
          { toolSpec: { name: 'get_weather', description: 'looks up the weather', inputSchema: { json: {} } } },
          { toolSpec: { name: 'bare_tool' } },
          { toolSpec: { description: 'nameless tools are skipped' } },
        ],
      },
      inferenceConfig: { temperature: 0.5, maxTokens: 32 },
    }

    const requestParams = extractRequestParamsConverse(params)

    assert.deepStrictEqual(requestParams.prompt, [
      { content: 'be brief', role: 'system' },
      { content: 'hi', role: 'user' },
      { role: 'tool', toolResults: [{ name: '', result: '21C', toolId: 't-1', type: 'tool_result' }] },
      { role: 'tool', toolResults: [{ name: '', result: '', toolId: 't-2', type: 'tool_result' }] },
    ])
    assert.strictEqual(requestParams.temperature, 0.5)
    assert.strictEqual(requestParams.maxTokens, 32)
    assert.deepStrictEqual(extractConverseToolDefinitions(params), [
      { name: 'get_weather', description: 'looks up the weather', schema: { json: {} } },
      { name: 'bare_tool', description: '', schema: {} },
    ])
  })

  it('renders nothing when the request carries no system, messages or tools', () => {
    assert.deepStrictEqual(extractRequestParamsConverse({}).prompt, [])
    assert.deepStrictEqual(extractConverseToolDefinitions({}), [])
    assert.strictEqual(extractMessagesFromConverseContent('user', undefined), undefined)
  })
})
