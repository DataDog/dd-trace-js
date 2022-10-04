'use strict'

const { isTrue, isFalse, isTrueOrFalse, globMatch } = require('../src/util')

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
const OTHERS = [
  undefined,
  null,
  'michel',
  42,
  NaN
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
      expect(isTrue(v)).to.equal(true)
      expect(isTrue(String(v))).to.equal(true)
    })
    FALSES.forEach((v) => {
      expect(isTrue(v)).to.equal(false)
      expect(isTrue(String(v))).to.equal(false)
    })
  })

  it('isFalse works', () => {
    FALSES.forEach((v) => {
      expect(isFalse(v)).to.equal(true)
      expect(isFalse(String(v))).to.equal(true)
    })
    TRUES.forEach((v) => {
      expect(isFalse(v)).to.equal(false)
      expect(isFalse(String(v))).to.equal(false)
    })
  })

  it('isTrueOrFalse works', () => {
    TRUES.forEach((v) => {
      expect(isTrueOrFalse(v)).to.equal(true)
      expect(isTrueOrFalse(String(v))).to.equal(true)
    })
    FALSES.forEach((v) => {
      expect(isTrueOrFalse(v)).to.equal(false)
      expect(isTrueOrFalse(String(v))).to.equal(false)
    })
    OTHERS.forEach((v) => {
      expect(isTrueOrFalse(v)).to.equal(undefined)
      expect(isTrueOrFalse(String(v))).to.equal(undefined)
    })
  })

  it('globMatch works', () => {
    MATCH_CASES.forEach(({ subject, pattern }) => {
      expect(globMatch(pattern, subject)).to.equal(true)
    })

    NONMATCH_CASES.forEach(({ subject, pattern }) => {
      expect(globMatch(pattern, subject)).to.equal(false)
    })
  })
})
