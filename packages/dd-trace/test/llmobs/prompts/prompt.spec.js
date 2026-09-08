'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const { ManagedPrompt } = require('../../../src/llmobs/prompts/prompt')

describe('ManagedPrompt', () => {
  it('creates text and chat prompts from responses', () => {
    const text = ManagedPrompt.fromResponse({ prompt_id: 'greeting', user_version: 2, template: 'Hi {name}' })
    assert.strictEqual(text.version, '2')
    assert.strictEqual(text.render({ name: 'Ada' }), 'Hi Ada')
    const chat = ManagedPrompt.fromResponse({ id: 'chat', version: '1', template: [{ content: '{{q}}' }] })
    assert.equal(chat.isChat, true)
    assert.deepEqual(chat.renderChat({ q: 'hello' }), [{ role: 'user', content: 'hello' }])
  })

  it('converts registry and fallback prompts to annotations', () => {
    const prompt = ManagedPrompt.fromResponse({ prompt_id: 'id', version: '1', template: 'Hi', label: 'prod' })
    assert.deepEqual(prompt.toAnnotation({ n: 1 }), {
      id: 'id',
      version: '1',
      template: 'Hi',
      variables: { n: '1' },
      tags: { label: 'prod' },
    })
    assert.strictEqual(ManagedPrompt.fromFallback(() => 'fallback', 'id').version, 'fallback')
  })
})
