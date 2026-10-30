'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { redactMessages } = require('../../src/aiguard/redaction')

describe('AI Guard redaction', () => {
  for (const path of [
    'messages[-1].content',
    'messages[0].con-tent',
    'messages[0].content ',
    'messages[0].content.',
  ]) {
    it(`skips malformed path ${path}`, () => {
      const messages = [{ role: 'user', content: 'secret' }]
      const result = redactMessages(messages, [{ path, replacement: '<REDACTED>' }])

      assert.strictEqual(result.messages, messages)
      assert.strictEqual(result.redacted, false)
      assert.strictEqual(result.failures, 1)
    })
  }

  it('rejects a long malformed segment without excessive backtracking', () => {
    const path = `messages[0].${'a'.repeat(100_000)}[${'9'.repeat(100_000)}x]`
    const messages = [{ role: 'user', content: 'secret' }]
    const result = redactMessages(messages, [{ path, replacement: '<REDACTED>' }])

    assert.strictEqual(result.messages, messages)
    assert.strictEqual(result.redacted, false)
    assert.strictEqual(result.failures, 1)
  })

  it('redacts message content, content-part text, and tool arguments in place', () => {
    const messages = [
      { role: 'user', content: [{ type: 'input_text', text: 'card 4111111111111111' }] },
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          function: { name: 'pay', arguments: '{"ssn":"123-45-6789"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'paid from 000123456789' },
    ]
    const replacements = [
      { path: 'messages[0].content[0].text', replacement: 'card <REDACTED>' },
      { path: 'messages[1].tool_calls[0].function.arguments', replacement: '{"ssn":"<REDACTED>"}' },
      { path: 'messages[2].content', replacement: 'paid from <REDACTED>' },
    ]

    const { messages: redacted } = redactMessages(messages, replacements)

    assert.strictEqual(redacted, messages)
    assert.deepStrictEqual(messages, [
      { role: 'user', content: [{ type: 'input_text', text: 'card <REDACTED>' }] },
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          function: { name: 'pay', arguments: '{"ssn":"<REDACTED>"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'paid from <REDACTED>' },
    ])
  })

  it('accepts an empty string as the remove placeholder', () => {
    const messages = [{ role: 'user', content: '123-45-6789' }]
    const { messages: redacted } = redactMessages(messages, [
      { path: 'messages[0].content', replacement: '' },
    ])

    assert.strictEqual(redacted[0].content, '')
  })

  it('accepts zero-padded indexes', () => {
    const messages = [{ role: 'user', content: 'secret' }]
    const result = redactMessages(messages, [{ path: 'messages[00].content', replacement: '<REDACTED>' }])

    assert.deepStrictEqual(result.messages, [{ role: 'user', content: '<REDACTED>' }])
    assert.strictEqual(result.redacted, true)
    assert.strictEqual(result.failures, 0)
  })

  it('applies zero-padded aliases as independent raw paths', () => {
    const messages = [{ role: 'user', content: 'secret' }]
    const result = redactMessages(messages, [
      { path: 'messages[0].content', replacement: '<A>' },
      { path: 'messages[00].content', replacement: '<B>' },
    ])

    assert.strictEqual(result.messages, messages)
    assert.strictEqual(result.messages[0].content, '<B>')
    assert.strictEqual(messages[0].content, '<B>')
    assert.strictEqual(result.redacted, true)
    assert.strictEqual(result.failures, 0)
  })

  it('applies identical duplicate entries once', () => {
    const messages = [{ role: 'user', content: '123-45-6789' }]
    const replacement = { path: 'messages[0].content', replacement: '<REDACTED>' }
    const result = redactMessages(messages, [replacement, replacement])

    assert.strictEqual(result.redacted, true)
    assert.strictEqual(result.failures, 0)
    assert.strictEqual(result.messages[0].content, '<REDACTED>')
  })

  it('keeps a conflicting path skipped after later duplicate values', () => {
    const messages = [{ role: 'user', content: '123-45-6789' }]
    const result = redactMessages(messages, [
      { path: 'messages[0].content', replacement: '<A>' },
      { path: 'messages[0].content', replacement: '<B>' },
      { path: 'messages[0].content', replacement: '<A>' },
    ])

    assert.strictEqual(result.messages, messages)
    assert.strictEqual(result.redacted, false)
    assert.strictEqual(result.failures, 1)
  })

  it('applies valid siblings while counting malformed and unresolvable entries', () => {
    const messages = [
      { role: 'system', content: 'ops@acme.io' },
      { role: 'user', content: '123-45-6789' },
    ]
    const result = redactMessages(messages, [
      { path: 'messages[0].content', replacement: '<REDACTED>' },
      { path: 'messages[9].content', replacement: 'missing' },
      { path: 'messages[1].content' },
    ])

    assert.deepStrictEqual(result.messages, [
      { role: 'system', content: '<REDACTED>' },
      { role: 'user', content: '123-45-6789' },
    ])
    assert.strictEqual(result.redacted, true)
    assert.strictEqual(result.failures, 2)
  })

  it('fails safe for invalid replacement collections and entries', () => {
    const messages = [{ role: 'user', content: 'secret' }]

    assert.deepStrictEqual(redactMessages(messages, { path: 'messages[0].content' }), {
      messages,
      redacted: false,
      failures: 1,
    })
    assert.deepStrictEqual(redactMessages(messages, [undefined]), {
      messages,
      redacted: false,
      failures: 1,
    })
    assert.deepStrictEqual(redactMessages(messages, [{ path: 42, replacement: '<REDACTED>' }]), {
      messages,
      redacted: false,
      failures: 1,
    })
    assert.deepStrictEqual(redactMessages(messages, []), {
      messages,
      redacted: false,
      failures: 0,
    })
  })

  for (const replacements of [false, 0, '']) {
    it(`treats the falsy non-array replacement collection ${JSON.stringify(replacements)} as malformed`, () => {
      const messages = [{ role: 'user', content: 'secret' }]

      const result = redactMessages(messages, replacements)

      assert.strictEqual(result.messages, messages)
      assert.strictEqual(messages[0].content, 'secret')
      assert.strictEqual(result.redacted, false)
      assert.strictEqual(result.failures, 1)
    })
  }

  for (const replacements of [null, undefined]) {
    it(`treats ${replacements === null ? 'null' : 'undefined'} replacements as absent`, () => {
      const messages = [{ role: 'user', content: 'secret' }]

      const result = redactMessages(messages, replacements)

      assert.strictEqual(result.messages, messages)
      assert.strictEqual(messages[0].content, 'secret')
      assert.strictEqual(result.redacted, false)
      assert.strictEqual(result.failures, 0)
    })
  }

  it('returns the original messages for an empty replacement array', () => {
    const messages = [{ role: 'user', content: 'secret' }]

    const result = redactMessages(messages, [])

    assert.strictEqual(result.messages, messages)
    assert.strictEqual(result.redacted, false)
    assert.strictEqual(result.failures, 0)
  })

  it('fails safe when reading a replacement target throws', () => {
    const message = { role: 'user' }
    Object.defineProperty(message, 'content', {
      enumerable: true,
      get () {
        throw new Error('unreadable')
      },
    })
    const messages = [message]

    assert.deepStrictEqual(redactMessages(messages, [
      { path: 'messages[0].content', replacement: '<REDACTED>' },
    ]), { messages, redacted: false, failures: 1 })
  })

  it('does not partially redact when a later target property read throws', () => {
    const unreadableMessage = { role: 'user' }
    Object.defineProperty(unreadableMessage, 'content', {
      enumerable: true,
      get () {
        throw new Error('unreadable')
      },
    })
    const messages = [
      { role: 'user', content: 'first secret' },
      unreadableMessage,
    ]

    const result = redactMessages(messages, [
      { path: 'messages[0].content', replacement: '<REDACTED>' },
      { path: 'messages[1].content', replacement: '<REDACTED>' },
    ])

    assert.strictEqual(result.messages, messages)
    assert.strictEqual(messages[0].content, 'first secret')
    assert.strictEqual(result.redacted, false)
    assert.strictEqual(result.failures, 1)
  })

  it('fails safe when replacement preprocessing throws', () => {
    const messages = [{ role: 'user', content: 'secret' }]
    const replacements = new Proxy([{}], {
      get (target, property, receiver) {
        if (property === Symbol.iterator) throw new Error('unreadable')
        return Reflect.get(target, property, receiver)
      },
    })

    const result = redactMessages(messages, replacements)

    assert.strictEqual(result.messages, messages)
    assert.strictEqual(result.redacted, false)
    assert.strictEqual(result.failures, 1)
  })

  for (const path of [
    'content',
    'messages.content',
    'messages[0].content',
    'messages[0].content[0]',
    'messages[0].role',
    'messages[0].content[0]',
    'messages[0].content[1].image_url.url',
    'messages[0].content[1].image_url.url.extra',
    'messages[1].tool_calls[0].function.name',
    'messages[1].tool_calls[0].id',
  ]) {
    it(`skips non-string, structural, or unsupported target ${path}`, () => {
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'hello' },
            { type: 'input_image', image_url: { url: 'https://example.com/image.png' } },
          ],
        },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', function: { name: 'search', arguments: '{}' } }],
        },
      ]
      const result = redactMessages(messages, [{ path, replacement: '<REDACTED>' }])

      assert.strictEqual(result.messages, messages)
      assert.strictEqual(result.redacted, false)
      assert.strictEqual(result.failures, 1)
    })
  }

  for (const { path, message } of [
    { path: 'messages[0].metadata.text', message: { role: 'user', metadata: { text: 'ops@acme.io' } } },
    {
      path: 'messages[0].tool_calls[0].arguments',
      message: { role: 'assistant', tool_calls: [{ id: 'call_1', arguments: '{"ssn":"123-45-6789"}' }] },
    },
    { path: 'messages[0].content.text', message: { role: 'user', content: { text: 'ops@acme.io' } } },
    { path: 'messages[0].function.arguments', message: { role: 'user', function: { arguments: '{}' } } },
  ]) {
    it(`skips string target reachable only outside the canonical productions ${path}`, () => {
      const messages = [message]

      const result = redactMessages(messages, [{ path, replacement: '<REDACTED>' }])

      assert.strictEqual(result.messages, messages)
      assert.strictEqual(result.redacted, false)
      assert.strictEqual(result.failures, 1)
    })
  }
})
