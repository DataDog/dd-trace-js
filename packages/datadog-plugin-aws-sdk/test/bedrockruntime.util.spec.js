'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  extractRequestParams,
  extractMessagesFromConverseContent,
  extractTextAndResponseReasonConverseFromStream,
  PROVIDER,
} = require('../src/services/bedrockruntime/utils')

describe('bedrockruntime utils', () => {
  it('combines Amazon Nova text blocks from the InvokeModel request body', () => {
    const requestParams = extractRequestParams({
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { text: 'Explain' },
            { image: { format: 'jpeg' } },
            { text: ' this image.' },
          ],
        }],
      }),
      modelId: 'amazon.nova-pro-v1:0',
    }, PROVIDER.AMAZON)

    assert.deepStrictEqual(requestParams.prompt, [{
      content: 'Explain this image.',
      role: 'user',
    }])
  })

  it('combines Anthropic text blocks from the InvokeModel request body', () => {
    const requestParams = extractRequestParams({
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            { type: 'image' },
            { type: 'text', text: ' this image.' },
          ],
        }],
      }),
      modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    }, PROVIDER.ANTHROPIC)

    assert.strictEqual(requestParams.prompt, 'Describe this image.')
  })

  it('combines Converse tool-result blocks', () => {
    const message = extractMessagesFromConverseContent('user', [{
      toolResult: {
        toolUseId: 'tool-1',
        content: [
          { text: 'Current weather: ' },
          { json: { temperature: 24 } },
        ],
      },
    }])

    assert.deepStrictEqual(message, {
      role: 'user',
      toolResults: [{
        name: '',
        result: 'Current weather: {"temperature":24}',
        toolId: 'tool-1',
        type: 'tool_result',
      }],
    })
  })

  it('reads the text of Converse guardContent blocks', () => {
    const message = extractMessagesFromConverseContent('user', [
      { text: 'Context: ' },
      { guardContent: { text: { text: 'What is the dose?', qualifiers: ['guard_content'] } } },
      { text: ' Cite sources.' },
    ])

    assert.deepStrictEqual(message, {
      role: 'user',
      content: 'Context: What is the dose? Cite sources.',
    })
  })

  describe('converse stream extractor', () => {
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
})
