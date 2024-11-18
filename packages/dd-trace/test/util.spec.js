'use strict'

require('./setup/tap')

const { isTrue, isFalse, globMatch } = require('../src/util')
const { generatePointerHash } = require('../src/util')

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

  it('globMatch works', () => {
    MATCH_CASES.forEach(({ subject, pattern }) => {
      expect(globMatch(pattern, subject)).to.equal(true)
    })

    NONMATCH_CASES.forEach(({ subject, pattern }) => {
      expect(globMatch(pattern, subject)).to.equal(false)
    })
  })
})

describe('generatePointerHash', () => {
  it('should generate a valid hash for a basic S3 object', () => {
    const hash = generatePointerHash(['some-bucket', 'some-key.data', 'ab12ef34'])
    expect(hash).to.equal('e721375466d4116ab551213fdea08413')
  })

  it('should generate a valid hash for an S3 object with a non-ascii key', () => {
    const hash1 = generatePointerHash(['some-bucket', 'some-key.你好', 'ab12ef34'])
    expect(hash1).to.equal('d1333a04b9928ab462b5c6cadfa401f4')
  })

  it('should generate a valid hash for multipart-uploaded S3 object', () => {
    const hash1 = generatePointerHash(['some-bucket', 'some-key.data', 'ab12ef34-5'])
    expect(hash1).to.equal('2b90dffc37ebc7bc610152c3dc72af9f')
  })
})
