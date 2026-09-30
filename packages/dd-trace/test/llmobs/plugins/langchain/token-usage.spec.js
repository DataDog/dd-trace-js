'use strict'

require('../../../setup/core')

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const ChatModelHandler = require('../../../../src/llmobs/plugins/langchain/handlers/chat_model')
const LlmHandler = require('../../../../src/llmobs/plugins/langchain/handlers/llm')

describe('langchain token usage', () => {
  const chatModel = new ChatModelHandler({})
  const llm = new LlmHandler({})

  it('reads the top-level usage a chat result reports', () => {
    const tokens = chatModel.getTokenUsage({
      llmOutput: { tokenUsage: { promptTokens: 11, completionTokens: 5, totalTokens: 16 } },
    })

    assert.deepStrictEqual(tokens, { inputTokens: 11, outputTokens: 5, totalTokens: 16 })
  })

  // some providers report usage on each generated message rather than on `llmOutput`
  it('falls back to the counts the generated messages carry', () => {
    const tokens = chatModel.getTokenUsage({
      generations: [[
        { message: { id: 'run-1-0', usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } },
      ]],
    })

    assert.deepStrictEqual(tokens, { inputTokens: 7, outputTokens: 3, totalTokens: 10 })
  })

  it('sums the counts of messages sharing a run', () => {
    const tokens = chatModel.getTokenUsage({
      generations: [[
        { message: { id: 'run-1-0', usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } },
        { message: { id: 'run-1-1', usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
      ]],
    })

    assert.deepStrictEqual(tokens, { inputTokens: 9, outputTokens: 4, totalTokens: 13 })
  })

  it('prefers the top-level usage over the per-message counts', () => {
    const tokens = chatModel.getTokenUsage({
      llmOutput: { tokenUsage: { promptTokens: 11, completionTokens: 5, totalTokens: 16 } },
      generations: [[
        { message: { id: 'run-1-0', usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } },
      ]],
    })

    assert.deepStrictEqual(tokens, { inputTokens: 11, outputTokens: 5, totalTokens: 16 })
  })

  it('reports zeros when neither the result nor the messages carry usage', () => {
    const tokens = chatModel.getTokenUsage({ generations: [[{ message: { id: 'run-1-0' } }]] })

    assert.deepStrictEqual(tokens, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })

  it('reports zeros for a result with no generations at all', () => {
    assert.deepStrictEqual(chatModel.getTokenUsage({}), { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })

  // completion models report usage only at the top level, so the handler keeps the base behavior
  it('does not apply the per-message fallback to a completion result', () => {
    const tokens = llm.getTokenUsage({
      generations: [[{ message: { usage_metadata: { input_tokens: 7, output_tokens: 3 } } }]],
    })

    assert.deepStrictEqual(tokens, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })
})
