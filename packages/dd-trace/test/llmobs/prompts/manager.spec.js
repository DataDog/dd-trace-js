'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const { PromptManager } = require('../../../src/llmobs/prompts/manager')

describe('PromptManager', () => {
  it('deduplicates registry requests and caches the result', async () => {
    let calls = 0
    const manager = new PromptManager({
      client: {
        getPrompt: async () => {
          calls++
          return { prompt_id: 'id', version: '1', template: 'Hi' }
        },
        appKey: 'app',
      },
    })
    const [first, second] = await Promise.all([manager.get('id'), manager.get('id')])
    assert.strictEqual(first, second)
    assert.strictEqual(calls, 1)
    assert.strictEqual((await manager.get('id')).render(), 'Hi')
  })

  it('uses lazy fallbacks when resolution cannot use an app key', async () => {
    let called = false
    const manager = new PromptManager({
      env: 'prod',
      client: { appKey: undefined, resolvePrompt: async () => { throw new Error('must not call') } },
    })
    const prompt = await manager.get('id', { fallback: () => { called = true; return 'fallback' } })
    assert.strictEqual(called, true)
    assert.strictEqual(prompt.source, 'fallback')
  })
})
