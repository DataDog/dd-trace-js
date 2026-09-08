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

  it('handles literal braces, mustache braces, and non-string values', () => {
    assert.strictEqual(safeSubstitute('a { b } c', { b: 'x' }), 'a x c')
    assert.strictEqual(safeSubstitute('{{name}} {count}', { name: 'Ada', count: 3 }), 'Ada 3')
    assert.strictEqual(safeSubstitute('{{missing}} {other}', {}), '{{missing}} {other}')
    assert.strictEqual(safeSubstitute('{{{{name}}}}', { name: 'Ada' }), '{{name}}')
    assert.strictEqual(safeSubstitute('{value}', { value: false }), 'false')
  })

  it('preserves escaped braces around substitutions', () => {
    assert.strictEqual(safeSubstitute('{{{{name}}}} {name}', { name: 'Ada' }), '{{name}} Ada')
    assert.strictEqual(safeSubstitute('literal {{ and }}', {}), 'literal {{and}}')
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

  it('extracts nested API error details and truncates long details', () => {
    assert.strictEqual(extractErrorDetail('{"error":{"message":"bad"}}'), 'bad')
    assert.strictEqual(extractErrorDetail('{"message":"oops"}'), 'oops')
    assert.strictEqual(extractErrorDetail('{"errors":[]}'), '{"errors":[]}')
    assert.strictEqual(extractErrorDetail('x'.repeat(600)).length, 500)
  })

  it('normalizes chat templates and defaults missing roles', () => {
    assert.deepEqual(extractTemplate({ chat_template: [{ content: 'hi' }, null, { content: 2 }] }), [
      { role: 'user', content: 'hi' },
    ])
    assert.strictEqual(extractTemplate({ template: 42 }), undefined)
  })

  it('renders text templates as user chat messages', () => {
    assert.deepEqual(renderChat('hello {{name}}', { name: 'Ada' }), [
      { role: 'user', content: 'hello Ada' },
    ])
  })

  it('sorts cache key attributes deterministically', () => {
    assert.strictEqual(
      cacheKey({ id: 'id', attributes: { b: { z: 1, a: 2 }, a: 3 } }),
      cacheKey({ id: 'id', attributes: { a: 3, b: { a: 2, z: 1 } } })
    )
  })
})
