'use strict'

const assert = require('node:assert/strict')

const [, StepLlmObsPlugin] = require('../../src/llmobs/plugins/claude-agent-sdk')

describe('claude-agent-sdk utils', () => {
  it('joins multiple tool outputs and returns undefined when none contain text', () => {
    const plugin = new StepLlmObsPlugin({}, { llmobs: { DD_LLMOBS_ENABLED: true } })
    const calls = []
    plugin._tagger = {
      tagTextIO (...args) {
        calls.push(args)
      },
    }
    const span = {}
    const context = {
      chunks: [{}],
      currentStore: { span },
      llmEndIdx: 0,
      llmStartIdx: 0,
    }

    plugin.setLLMObsTags({
      ...context,
      toolOutputs: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
    })
    plugin.setLLMObsTags({ ...context, toolOutputs: [[]] })

    assert.strictEqual(calls.length, 2)
    assert.strictEqual(calls[0][0], span)
    assert.strictEqual(calls[0][1], '')
    assert.strictEqual(calls[0][2], 'first\nsecond')
    assert.strictEqual(calls[1][2], undefined)
  })
})
