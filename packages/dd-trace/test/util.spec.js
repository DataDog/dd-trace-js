'use strict'

require('./setup/tap')

const { isTrue, isFalse, globMatch } = require('../src/util')
const { generatePointerHash, encodeValue, extractPrimaryKeys } = require('../src/util')

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

describe('encodeValue', () => {
  describe('basic type handling', () => {
    it('handles string (S) type correctly', () => {
      const result = encodeValue({ S: 'hello world' })
      expect(Buffer.isBuffer(result)).to.be.true
      expect(result).to.deep.equal(Buffer.from('hello world'))
    })

    it('handles number (N) as string type correctly', () => {
      const result = encodeValue({ N: '123.45' })
      expect(Buffer.isBuffer(result)).to.be.true
      expect(result).to.deep.equal(Buffer.from('123.45'))
    })

    it('handles number (N) as type string or number the same', () => {
      const result1 = encodeValue({ N: 456.78 })
      const result2 = encodeValue({ N: '456.78' })
      expect(Buffer.isBuffer(result1)).to.be.true
      expect(result1).to.deep.equal(result2)
    })

    it('handles binary (B) type correctly', () => {
      const binaryData = Buffer.from([1, 2, 3])
      const result = encodeValue({ B: binaryData })
      expect(Buffer.isBuffer(result)).to.be.true
      expect(result).to.deep.equal(binaryData)
    })
  })

  describe('edge cases', () => {
    it('returns undefined for null input', () => {
      const result = encodeValue(null)
      expect(result).to.be.undefined
    })

    it('returns undefined for undefined input', () => {
      const result = encodeValue(undefined)
      expect(result).to.be.undefined
    })

    it('returns undefined for unsupported type', () => {
      const result = encodeValue({ A: 'abc' })
      expect(result).to.be.undefined
    })

    it('returns undefined for malformed input', () => {
      const result = encodeValue({})
      expect(result).to.be.undefined
    })

    it('handles empty string values', () => {
      const result = encodeValue({ S: '' })
      expect(Buffer.isBuffer(result)).to.be.true
      expect(result.length).to.equal(0)
    })

    it('handles empty buffer', () => {
      const result = encodeValue({ B: Buffer.from([]) })
      expect(Buffer.isBuffer(result)).to.be.true
      expect(result.length).to.equal(0)
    })
  })
})

describe('extractPrimaryKeys', () => {
  describe('single key table', () => {
    it('handles string key with Set input', () => {
      const keySet = new Set(['userId'])
      const item = { userId: { S: 'user123' } }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.deep.equal(['userId', Buffer.from('user123'), '', ''])
    })

    it('handles number key with Set input', () => {
      const keySet = new Set(['timestamp'])
      const item = { timestamp: { N: '1234567' } }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.deep.equal(['timestamp', Buffer.from('1234567'), '', ''])
    })

    it('handles binary key with Set input', () => {
      const keySet = new Set(['binaryId'])
      const binaryData = Buffer.from([1, 2, 3])
      const item = { binaryId: { B: binaryData } }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.deep.equal(['binaryId', binaryData, '', ''])
    })

    it('handles string key with Object input', () => {
      const keyObj = { userId: { S: 'user123' } }
      const result = extractPrimaryKeys(keyObj, keyObj)
      expect(result).to.deep.equal(['userId', Buffer.from('user123'), '', ''])
    })
  })

  describe('double key table', () => {
    it('handles and sorts string-string composite key', () => {
      const keySet = new Set(['userId', 'email'])
      const item = {
        userId: { S: 'user123' },
        email: { S: 'test@example.com' }
      }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.deep.equal(['email', Buffer.from('test@example.com'), 'userId', Buffer.from('user123')])
    })

    it('handles and sorts string-number composite key', () => {
      const keySet = new Set(['timestamp', 'userId'])
      const item = {
        timestamp: { N: '1234567' },
        userId: { S: 'user123' }
      }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.deep.equal(['timestamp', Buffer.from('1234567'), 'userId', Buffer.from('user123')])
    })

    it('handles and sorts composite key with Object input', () => {
      const keyObj = {
        userId: { S: 'user123' },
        timestamp: { N: '1234567' }
      }
      const result = extractPrimaryKeys(keyObj, keyObj)
      expect(result).to.deep.equal(['timestamp', Buffer.from('1234567'), 'userId', Buffer.from('user123')])
    })
  })

  describe('edge cases', () => {
    it('returns undefined when missing values', () => {
      const keySet = new Set(['userId', 'timestamp'])
      const item = { userId: { S: 'user123' } } // timestamp missing
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.be.undefined
    })

    it('returns undefined when invalid value types', () => {
      const keySet = new Set(['userId', 'timestamp'])
      const item = {
        userId: { S: 'user123' },
        timestamp: { INVALID: '1234567' }
      }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.be.undefined
    })

    it('handles empty Set input', () => {
      const result = extractPrimaryKeys(new Set([]), {})
      expect(result).to.be.undefined
    })

    it('returns undefined when null values in item', () => {
      const keySet = new Set(['key1', 'key2'])
      const item = {
        key1: null,
        key2: { S: 'value2' }
      }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.be.undefined
    })

    it('returns undefined when undefined values in item', () => {
      const keySet = new Set(['key1', 'key2'])
      const item = {
        key2: { S: 'value2' }
      }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.be.undefined
    })
  })
})
