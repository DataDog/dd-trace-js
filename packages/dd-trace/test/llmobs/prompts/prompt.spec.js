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

  it('supports fallback strings, chat arrays, and metadata objects', () => {
    assert.strictEqual(ManagedPrompt.fromFallback('hello', 'id').render(), 'hello')
    assert.deepEqual(ManagedPrompt.fromFallback([{ role: 'user', content: 'hi' }], 'id').renderChat(), [
      { role: 'user', content: 'hi' },
    ])
    const prompt = ManagedPrompt.fromFallback({
      template: 'hello {name}',
      version: 'v2',
      label: 'prod',
    }, 'id')
    assert.strictEqual(prompt.version, 'v2')
    assert.strictEqual(prompt.label, 'prod')
    assert.strictEqual(prompt.render({ name: 'Ada' }), 'hello Ada')
  })

  it('rejects malformed fallback objects', () => {
    assert.throws(() => ManagedPrompt.fromFallback({ version: 'v1' }, 'id'), {
      name: 'TypeError',
      message: 'Fallback must contain a template or chat_template',
    })
  })

  it('rejects responses without templates', () => {
    assert.throws(() => ManagedPrompt.fromResponse({ prompt_id: 'id', version: 1 }), {
      name: 'PromptAPIError',
      message: 'Prompt response is missing a template',
    })
  })

  it('renders chat prompts and annotates variables as strings', () => {
    const prompt = ManagedPrompt.fromResponse({
      prompt_id: 'chat',
      version: 1,
      chat_template: [{ role: 'system', content: 'Hi {name}' }],
    })
    assert.deepEqual(prompt.renderChat({ name: 'Ada', count: 2 }), [
      { role: 'system', content: 'Hi Ada' },
    ])
    assert.deepEqual(prompt.toAnnotation({ count: 2 }).variables, { count: '2' })
  })

  it('preserves labels only for registry annotations', () => {
    const registry = ManagedPrompt.fromResponse({ prompt_id: 'id', version: 1, template: 'x' }, { label: 'prod' })
    const fallback = ManagedPrompt.fromFallback({ template: 'x', label: 'prod' }, 'id')
    assert.deepEqual(registry.toAnnotation().tags, { label: 'prod' })
    assert.strictEqual(fallback.toAnnotation().tags, undefined)
  })
})
