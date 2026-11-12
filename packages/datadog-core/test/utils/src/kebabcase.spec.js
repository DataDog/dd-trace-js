'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../../../../dd-trace/test/setup/core')
const kebabcase = require('../../../src/utils/src/kebabcase')

describe('kebabcase', () => {
  it('converts camelCase and collapses spaces/underscores', () => {
    assert.strictEqual(kebabcase('fooBar'), 'foo-bar')
    assert.strictEqual(kebabcase('foo_bar baz'), 'foo-bar-baz')
    assert.strictEqual(kebabcase('XMLHttpRequest'), 'xmlhttp-request')
  })

  it('trims leading and trailing dashes but keeps internal ones', () => {
    assert.strictEqual(kebabcase('-a-'), 'a')
    assert.strictEqual(kebabcase('--a--'), 'a')
    assert.strictEqual(kebabcase('_a_'), 'a')
    assert.strictEqual(kebabcase('a-b'), 'a-b')
    assert.strictEqual(kebabcase('a--b'), 'a--b')
  })

  it('handles all-dash and empty inputs', () => {
    assert.strictEqual(kebabcase('---'), '')
    assert.strictEqual(kebabcase(''), '')
    assert.strictEqual(kebabcase('   '), '')
  })

  it('throws on non-string input', () => {
    assert.throws(() => kebabcase(42), { name: 'TypeError', message: 'Expected a string' })
  })
})
