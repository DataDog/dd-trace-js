'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const ManagedPrompt = require('../../../src/llmobs/prompts/prompt')

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

  it('expands message placeholders in place without tracking or rendering their values', () => {
    const prompt = new ManagedPrompt({
      id: 'chat',
      version: '3',
      source: 'registry',
      template: [
        { role: 'system', content: 'Plan: {{ plan }}' },
        { type: 'placeholder', name: 'history' },
        { role: 'user', content: '{{ question }}' },
        { type: 'placeholder', name: 'history' },
        { type: 'placeholder', name: 'empty' },
      ],
    })
    const history = [
      { role: 'assistant', content: '{{ opaque }}', tool_call_id: 'call-1' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ name: 'lookup', arguments: { id: 1 }, tool_id: 'call-1', function: null, type: null }],
      },
      { role: 'tool', tool_results: [{ name: 'lookup', result: 'found', tool_id: 'call-1' }] },
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call-2',
          type: 'function',
          function: { name: 'lookup', arguments: '{"id":2}' },
          provider_extension: { opaque: true },
        }],
      },
      { role: 'tool', content: 'found', tool_call_id: 'call-2', tool_calls: null, tool_results: null },
    ]
    const variables = { plan: 'pro', question: 'Why?', history, empty: [] }

    const expected = structuredClone([
      { role: 'system', content: 'Plan: pro' },
      ...history,
      { role: 'user', content: 'Why?' },
      ...history,
    ])
    const rendered = prompt.format(variables)
    assert.deepStrictEqual(rendered, expected)
    history[0].content = 'changed'
    assert.strictEqual(rendered[1].content, '{{ opaque }}')
    assert.deepStrictEqual(prompt.toAnnotation(variables), {
      id: 'chat',
      version: '3',
      template: [
        { role: 'system', content: 'Plan: {{ plan }}' },
        { type: 'placeholder', name: 'history' },
        { role: 'user', content: '{{ question }}' },
        { type: 'placeholder', name: 'history' },
        { type: 'placeholder', name: 'empty' },
      ],
      variables: { plan: 'pro', question: 'Why?' },
    })
    assert.throws(() => prompt.format({ plan: 'pro', question: 'Why?', empty: [] }), {
      name: 'TypeError',
      message: /Missing.*history/,
    })
    for (const malformed of [
      null,
      'history',
      {},
      [{ role: 'user' }],
      [{ role: 'assistant', content: null }],
      [{ role: 'assistant', tool_calls: [] }],
      [{ role: 'assistant', content: [{ type: 'image' }], tool_calls: [{}] }],
      [{ role: 'assistant', tool_calls: [{ function: { name: 'lookup', arguments: {} } }] }],
      [{ role: 'assistant', tool_calls: [{ function: { name: 42, arguments: '{}' } }] }],
      [{ role: 'assistant', tool_calls: [{ function: Object.assign([], { name: 'lookup', arguments: '{}' }) }] }],
      [{ role: 'assistant', content: 'text', tool_calls: 'invalid' }],
      [{ role: 'assistant', tool_calls: [null] }],
      [{ role: 'assistant', tool_calls: [{ name: 42 }] }],
      [{ role: 'tool', content: 'result', tool_call_id: 42 }],
      [{ role: 'tool', tool_results: [42] }],
      [{ type: 'placeholder', name: 'nested', role: 'user', content: 'x' }],
    ]) {
      assert.throws(() => prompt.format({ history: malformed, empty: [] }), {
        name: 'TypeError',
        message: /Invalid.*history/,
      })
    }
  })

  it('supports string, chat, object, and synchronous callable fallbacks', () => {
    const string = ManagedPrompt.fromFallback('p', 'Hello {name}')
    const chat = ManagedPrompt.fromFallback('p', [{ role: 'user', content: 'Hi {name}' }])
    const object = ManagedPrompt.fromFallback('p', { template: 'Local', version: 'local-v1' })
    const placeholder = ManagedPrompt.fromFallback('p', [{ type: 'placeholder', name: 'history' }])
    let calls = 0
    const callable = ManagedPrompt.fromFallback('p', () => {
      calls++
      return 'Lazy'
    })

    assert.strictEqual(string.format({ name: 'A' }), 'Hello A')
    assert.deepStrictEqual(chat.format({ name: 'B' }), [{ role: 'user', content: 'Hi B' }])
    assert.strictEqual(object.version, 'local-v1')
    assert.deepStrictEqual(placeholder.format({ history: [] }), [])
    assert.strictEqual(callable.template, 'Lazy')
    assert.strictEqual(calls, 1)
    for (const prompt of [string, chat, object, placeholder, callable]) assert.strictEqual(prompt.source, 'fallback')
  })

  it('rejects malformed caller fallbacks immediately', () => {
    const invalidFallbacks = [
      { version: 'local-v1' },
      [{ role: 'user', content: 42 }],
      [{ role: 'assistant', content: null, tool_calls: [{ name: 'lookup' }] }],
      [{ role: 'tool', tool_results: [{ result: 'found' }] }],
    ]

    for (const fallback of invalidFallbacks) {
      assert.throws(() => ManagedPrompt.fromFallback('p', fallback), {
        name: 'TypeError',
        message: /Invalid prompt fallback/,
      })
    }
  })
})
