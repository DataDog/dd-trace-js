'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const {
  cacheKey,
  escapeId,
  extractErrorDetail,
  extractTemplate,
  parseCacheKey,
  renderChat,
  safeSubstitute,
} = require('../../../src/llmobs/prompts/util')

describe('prompt utilities', () => {
  it('extracts and normalizes templates', () => {
    assert.deepEqual(extractTemplate({
      chat_template: [{ role: 'system', content: 'a', extra: true }, { content: 4 }, { content: 'b' }],
    }), [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }])
    assert.strictEqual(extractTemplate({ template: 'hello' }), 'hello')
  })

  it('substitutes supported placeholders and preserves missing values', () => {
    assert.strictEqual(safeSubstitute('Hello {name} {{other}}', { name: 'Ada', other: 2 }), 'Hello Ada 2')
    assert.strictEqual(safeSubstitute('Hello {name}', {}), 'Hello {name}')
    assert.strictEqual(safeSubstitute('{{{{name}}}}', { name: 'Ada' }), '{{name}}')
    assert.strictEqual(safeSubstitute('{bad-name}', { 'bad-name': 'x' }), '{bad-name}')
  })

  it('renders chat templates', () => {
    assert.deepEqual(renderChat('hello {name}', { name: 'Ada' }), [{ role: 'user', content: 'hello Ada' }])
    assert.deepEqual(renderChat([{ role: 'system', content: '{name}' }], { name: 'Ada' }), [
      { role: 'system', content: 'Ada' },
    ])
  })

  it('extracts error details and builds exact cache keys', () => {
    assert.strictEqual(extractErrorDetail('{"errors":[{"detail":"bad"}]}'), 'bad')
    assert.strictEqual(extractErrorDetail(' raw '), 'raw')
    const key = cacheKey({ id: 'foo', attributes: { z: 1, a: 2 } })
    assert.strictEqual(parseCacheKey(key).id, 'foo')
    assert.strictEqual(escapeId('hello world/1'), 'hello%20world%2F1')
  })
})
