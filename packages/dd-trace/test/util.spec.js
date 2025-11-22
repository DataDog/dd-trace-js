'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { describe, it } = require('tap').mocha

require('./setup/core')

const { isTrue, isFalse, globMatch } = require('../src/util')

const TRUES = [
  1,
  true,
  'true',
  'TRUE',
  'tRuE'
]
const FALSES = [
  0,
  false,
  'false',
  'FALSE',
  'fAlSe'
]

const MATCH_CASES = [
  { pattern: 'foo', subject: 'foo' },
  { pattern: 'foo.*', subject: 'foo.you' },
  { pattern: 'hi*there', subject: 'hithere' },
  { pattern: '*stuff', subject: 'lots of stuff' },
  { pattern: 'test.?', subject: 'test.1' },
  { pattern: '*a*a*a*a*a*a', subject: 'aaaaaaaarrrrrrraaaraaarararaarararaarararaaa' }
]

const NONMATCH_CASES = [
  { pattern: 'foo.*', subject: 'snafoo.' },
  { pattern: 'test.?', subject: 'test.abc' },
  { pattern: '*stuff', subject: 'stuff to think about' },
  { pattern: 'test?test', subject: 'test123test' }
]

describe('util', () => {
  it('isTrue works', () => {
    TRUES.forEach((v) => {
      assert.strictEqual(isTrue(v), true)
      expect(isTrue(String(v))).to.equal(true)
    })
    FALSES.forEach((v) => {
      assert.strictEqual(isTrue(v), false)
      expect(isTrue(String(v))).to.equal(false)
    })
  })

  it('isFalse works', () => {
    FALSES.forEach((v) => {
      assert.strictEqual(isFalse(v), true)
      expect(isFalse(String(v))).to.equal(true)
    })
    TRUES.forEach((v) => {
      assert.strictEqual(isFalse(v), false)
      expect(isFalse(String(v))).to.equal(false)
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
})
