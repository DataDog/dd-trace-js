'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const { createPrompts } = require('../../../src/llmobs/prompts')

describe('prompt facade', () => {
  it('returns a no-op facade while LLMObs is disabled', async () => {
    const prompts = createPrompts({ llmobs: { DD_LLMOBS_ENABLED: false } })
    assert.strictEqual(typeof prompts.get, 'function')
    const prompt = await prompts.get('id', { fallback: 'fallback' })
    assert.strictEqual(prompt.render(), 'fallback')
    await assert.rejects(prompts.list(),
      error => error instanceof Error && 'status' in error && error.status === 0)
  })
})
