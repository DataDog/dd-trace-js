'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const ManagedPrompt = require('../../../src/llmobs/prompts/prompt')
const promptTracking = require('../../../src/llmobs/prompts/tracking')

describe('ManagedPrompt', () => {
  it('renders text safely and builds a string-valued annotation', () => {
    const prompt = new ManagedPrompt({
      id: 'greeting',
      version: '1',
      source: 'registry',
      template: 'Hello {name}, {{ count }} times; {missing}',
      promptUuid: 'prompt-uuid',
      promptVersionUuid: 'version-uuid',
    })

    assert.strictEqual(prompt.format({ name: 'Ada', count: 3 }), 'Hello Ada, 3 times; {missing}')
    assert.deepStrictEqual(prompt.toAnnotation({ name: 'Ada', count: 3, enabled: false }), {
      id: 'greeting',
      version: '1',
      template: 'Hello {name}, {{ count }} times; {missing}',
      variables: { name: 'Ada', count: '3', enabled: 'false' },
      promptUuid: 'prompt-uuid',
      promptVersionUuid: 'version-uuid',
    })
    assert.ok(Object.isFrozen(prompt))
  })

  it('copies, freezes, and renders chat templates without mutation', () => {
    const template = [
      { role: 'system', content: 'You are {{ persona }}.' },
      { role: 'user', content: '{question}' },
    ]
    const prompt = new ManagedPrompt({ id: 'chat', version: '2', source: 'resolve', template })
    template[0].content = 'changed'

    const rendered = prompt.format({ persona: 'helpful', question: 'Why?' })

    assert.deepStrictEqual(rendered, [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Why?' },
    ])
    assert.notStrictEqual(rendered, prompt.template)
    assert.strictEqual(prompt.template[0].content, 'You are {{ persona }}.')
    assert.ok(Object.isFrozen(prompt.template))
    assert.ok(Object.isFrozen(prompt.template[0]))

    const annotation = prompt.toAnnotation()
    annotation.template[0].content = 'changed annotation'
    assert.strictEqual(prompt.template[0].content, 'You are {{ persona }}.')
  })

  it('tracks the exact rendered chat value without changing its JavaScript shape', () => {
    const first = new ManagedPrompt({
      id: 'first',
      version: '1',
      source: 'registry',
      template: [{ role: 'user', content: 'Hello {name}' }],
    })
    const second = new ManagedPrompt({
      id: 'second',
      version: '2',
      source: 'registry',
      template: [{ role: 'user', content: 'Hello {name}' }],
    })

    const firstRendered = first.format({ name: 'Ada' })
    const secondRendered = second.format({ name: 'Ada' })

    assert.ok(Array.isArray(firstRendered))
    assert.deepStrictEqual(firstRendered, [{ role: 'user', content: 'Hello Ada' }])
    assert.deepStrictEqual(JSON.parse(JSON.stringify(firstRendered)), firstRendered)
    assert.deepStrictEqual(promptTracking.getTrackedPrompt(firstRendered), first.toAnnotation({ name: 'Ada' }))
    assert.deepStrictEqual(promptTracking.getTrackedPrompt(secondRendered), second.toAnnotation({ name: 'Ada' }))
    assert.deepStrictEqual(
      promptTracking.getTrackedPrompt({ messages: secondRendered }),
      second.toAnnotation({ name: 'Ada' })
    )
    assert.strictEqual(promptTracking.getTrackedPrompt([...firstRendered]), undefined)
    assert.strictEqual(promptTracking.getTrackedPrompt(new Proxy({}, {
      ownKeys () { throw new Error('nope') },
    })), undefined)
  })

  it('supports string, chat, object, and synchronous callable fallbacks', () => {
    const string = ManagedPrompt.fromFallback('p', 'Hello {name}')
    const chat = ManagedPrompt.fromFallback('p', [{ role: 'user', content: 'Hi {name}' }])
    const object = ManagedPrompt.fromFallback('p', { template: 'Local', version: 'local-v1' })
    let calls = 0
    const callable = ManagedPrompt.fromFallback('p', () => {
      calls++
      return 'Lazy'
    })

    assert.strictEqual(string.format({ name: 'A' }), 'Hello A')
    assert.deepStrictEqual(chat.format({ name: 'B' }), [{ role: 'user', content: 'Hi B' }])
    assert.strictEqual(object.version, 'local-v1')
    assert.strictEqual(callable.template, 'Lazy')
    assert.strictEqual(calls, 1)
    for (const prompt of [string, chat, object, callable]) assert.strictEqual(prompt.source, 'fallback')
  })
})
