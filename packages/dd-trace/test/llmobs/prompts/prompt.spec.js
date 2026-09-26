'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const ManagedPrompt = require('../../../src/llmobs/prompts/prompt')

describe('ManagedPrompt', () => {
  it('renders text safely and builds a string-valued annotation', () => {
    const config = { model: { temperature: 0.2 }, unknown: [1, true] }
    const prompt = new ManagedPrompt({
      id: 'greeting',
      version: '1',
      source: 'registry',
      template: 'Hello {name}, {{ count }} times; {missing}',
      config,
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
    assert.ok(Object.isFrozen(prompt.config))
    assert.ok(Object.isFrozen(prompt.config.model))
    assert.ok(Object.isFrozen(prompt.config.unknown))
    config.model.temperature = 1
    assert.throws(() => { prompt.config.model.temperature = 1 }, TypeError)
    assert.deepStrictEqual(prompt.config, { model: { temperature: 0.2 }, unknown: [1, true] })
  })

  it('renders only balanced single- and double-brace placeholders', () => {
    const prompt = new ManagedPrompt({
      id: 'balanced',
      version: '1',
      source: 'registry',
      template: '{{double}} {single} | {{double} | {single}} | {{{double}}} | JSON: {"age": {age}}',
    })

    assert.strictEqual(
      prompt.format({ double: 'two', single: 'one', age: 42 }),
      'two one | {{double} | {single}} | {{{double}}} | JSON: {"age": {age}}'
    )
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

  it('supports string, chat, object, and synchronous callable fallbacks', () => {
    const string = ManagedPrompt.fromFallback('p', 'Hello {name}')
    const chat = ManagedPrompt.fromFallback('p', [{ role: 'user', content: 'Hi {name}' }])
    const object = ManagedPrompt.fromFallback('p', {
      template: 'Local',
      version: 'local-v1',
      config: { model: { temperature: 0.4 } },
    })
    let calls = 0
    const callable = ManagedPrompt.fromFallback('p', () => {
      calls++
      return 'Lazy'
    })

    assert.strictEqual(string.format({ name: 'A' }), 'Hello A')
    assert.deepStrictEqual(chat.format({ name: 'B' }), [{ role: 'user', content: 'Hi B' }])
    assert.strictEqual(object.version, 'local-v1')
    assert.deepStrictEqual(object.config, { model: { temperature: 0.4 } })
    assert.strictEqual(callable.template, 'Lazy')
    assert.strictEqual(calls, 1)
    for (const prompt of [string, chat, object, callable]) assert.strictEqual(prompt.source, 'fallback')
  })

  it('rejects malformed caller fallbacks immediately', () => {
    const invalidFallbacks = [
      { version: 'local-v1' },
      [{ role: 'user', content: 42 }],
    ]

    for (const fallback of invalidFallbacks) {
      assert.throws(() => ManagedPrompt.fromFallback('p', fallback), {
        name: 'TypeError',
        message: 'Invalid prompt fallback: expected a string, chat message array, or object with a template',
      })
    }
    assert.throws(
      () => ManagedPrompt.fromFallback('p', { template: 'Local', config: [] }),
      { name: 'TypeError', message: 'Invalid prompt config: expected a JSON object' }
    )
  })
})
