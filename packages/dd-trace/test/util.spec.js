'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('./setup/core')
const { isEmpty, isTrue, isFalse, globMatch } = require('../src/util')

const TRUES = [
  1,
  true,
  'true',
  'TRUE',
  'tRuE',
]
const FALSES = [
  0,
  false,
  'false',
  'FALSE',
  'fAlSe',
]

const MATCH_CASES = [
  { pattern: 'foo', subject: 'foo' },
  { pattern: 'foo.*', subject: 'foo.you' },
  { pattern: 'hi*there', subject: 'hithere' },
  { pattern: '*stuff', subject: 'lots of stuff' },
  { pattern: 'test.?', subject: 'test.1' },
  { pattern: '*a*a*a*a*a*a', subject: 'aaaaaaaarrrrrrraaaraaarararaarararaarararaaa' },
]

const NONMATCH_CASES = [
  { pattern: 'foo.*', subject: 'snafoo.' },
  { pattern: 'test.?', subject: 'test.abc' },
  { pattern: '*stuff', subject: 'stuff to think about' },
  { pattern: 'test?test', subject: 'test123test' },
]

describe('util', () => {
  it('isTrue works', () => {
    TRUES.forEach((v) => {
      assert.strictEqual(isTrue(v), true)
      assert.strictEqual(isTrue(String(v)), true)
    })
    FALSES.forEach((v) => {
      assert.strictEqual(isTrue(v), false)
      assert.strictEqual(isTrue(String(v)), false)
    })
  })

  it('isFalse works', () => {
    FALSES.forEach((v) => {
      assert.strictEqual(isFalse(v), true)
      assert.strictEqual(isFalse(String(v)), true)
    })
    TRUES.forEach((v) => {
      assert.strictEqual(isFalse(v), false)
      assert.strictEqual(isFalse(String(v)), false)
    })
  })

  it('globMatch works', () => {
    MATCH_CASES.forEach(({ subject, pattern }) => {
      assert.strictEqual(globMatch(pattern, subject), true)
    })

    NONMATCH_CASES.forEach(({ subject, pattern }) => {
      assert.strictEqual(globMatch(pattern, subject), false)
    })
  })

  it('isEmpty works', () => {
    assert.strictEqual(isEmpty({}), true)
    assert.strictEqual(isEmpty(Object.create(null)), true)
    assert.strictEqual(isEmpty({ a: 1 }), false)
    assert.strictEqual(isEmpty(Object.assign(Object.create({ inherited: 1 }), { own: 2 })), false)
    // `for-in` walks inherited enumerable keys, so a prototype-only object counts as non-empty.
    assert.strictEqual(isEmpty(Object.create({ inherited: 1 })), false)
  })
})
