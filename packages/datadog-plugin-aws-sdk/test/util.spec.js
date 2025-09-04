'use strict'

const { expect } = require('chai')
const { describe, it } = require('mocha')

const { Buffer } = require('node:buffer')

const { generatePointerHash, encodeValue, extractPrimaryKeys } = require('../src/util')

describe('generatePointerHash', () => {
  describe('should generate a valid hash for S3 object with', () => {
    it('basic values', () => {
      const hash = generatePointerHash(['some-bucket', 'some-key.data', 'ab12ef34'])
      expect(hash).to.equal('e721375466d4116ab551213fdea08413')
    })

    it('non-ascii key', () => {
      const hash = generatePointerHash(['some-bucket', 'some-key.你好', 'ab12ef34'])
      expect(hash).to.equal('d1333a04b9928ab462b5c6cadfa401f4')
    })

    it('multipart-upload', () => {
      const hash = generatePointerHash(['some-bucket', 'some-key.data', 'ab12ef34-5'])
      expect(hash).to.equal('2b90dffc37ebc7bc610152c3dc72af9f')
    })
  })

  describe('should generate a valid hash for DynamoDB item with', () => {
    it('one string primary key', () => {
      const hash = generatePointerHash(['some-table', 'some-key', 'some-value', '', ''])
      expect(hash).to.equal('7f1aee721472bcb48701d45c7c7f7821')
    })

    it('one buffered binary primary key', () => {
      const hash = generatePointerHash(['some-table', 'some-key', Buffer.from('some-value'), '', ''])
      expect(hash).to.equal('7f1aee721472bcb48701d45c7c7f7821')
    })

    it('one number primary key', () => {
      const hash = generatePointerHash(['some-table', 'some-key', '123.456', '', ''])
      expect(hash).to.equal('434a6dba3997ce4dbbadc98d87a0cc24')
    })

    it('one buffered number primary key', () => {
      const hash = generatePointerHash(['some-table', 'some-key', Buffer.from('123.456'), '', ''])
      expect(hash).to.equal('434a6dba3997ce4dbbadc98d87a0cc24')
    })

    it('string and number primary key', () => {
      // sort primary keys lexicographically
      const hash = generatePointerHash(['some-table', 'other-key', '123', 'some-key', 'some-value'])
      expect(hash).to.equal('7aa1b80b0e49bd2078a5453399f4dd67')
    })

    it('buffered string and number primary key', () => {
      const hash = generatePointerHash([
        'some-table',
        'other-key',
        Buffer.from('123'),
        'some-key', Buffer.from('some-value')
      ])
      expect(hash).to.equal('7aa1b80b0e49bd2078a5453399f4dd67')
    })
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
    it('handles string key', () => {
      const keySet = ['userId']
      const item = { userId: { S: 'user123' } }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.deep.equal(['userId', Buffer.from('user123'), '', ''])
    })

    it('handles number key', () => {
      const keySet = ['timestamp']
      const item = { timestamp: { N: '1234567' } }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.deep.equal(['timestamp', Buffer.from('1234567'), '', ''])
    })

    it('handles binary key', () => {
      const keySet = ['binaryId']
      const binaryData = Buffer.from([1, 2, 3])
      const item = { binaryId: { B: binaryData } }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.deep.equal(['binaryId', binaryData, '', ''])
    })
  })

  describe('double key table', () => {
    it('handles and sorts string-string keys', () => {
      const keySet = ['userId', 'email']
      const item = {
        userId: { S: 'user123' },
        email: { S: 'test@example.com' }
      }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.deep.equal(['email', Buffer.from('test@example.com'), 'userId', Buffer.from('user123')])
    })

    it('handles and sorts string-number keys', () => {
      const keySet = ['timestamp', 'userId']
      const item = {
        timestamp: { N: '1234567' },
        userId: { S: 'user123' }
      }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.deep.equal(['timestamp', Buffer.from('1234567'), 'userId', Buffer.from('user123')])
    })
  })

  describe('edge cases', () => {
    it('returns undefined when missing values', () => {
      const keySet = ['userId', 'timestamp']
      const item = { userId: { S: 'user123' } } // timestamp missing
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.be.undefined
    })

    it('returns undefined when invalid value types', () => {
      const keySet = ['userId', 'timestamp']
      const item = {
        userId: { S: 'user123' },
        timestamp: { INVALID: '1234567' }
      }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.be.undefined
    })

    it('handles empty Set input', () => {
      const result = extractPrimaryKeys([], {})
      expect(result).to.be.undefined
    })

    it('returns undefined when null values in item', () => {
      const keySet = ['key1', 'key2']
      const item = {
        key1: null,
        key2: { S: 'value2' }
      }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.be.undefined
    })

    it('returns undefined when undefined values in item', () => {
      const keySet = ['key1', 'key2']
      const item = {
        key2: { S: 'value2' }
      }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.be.undefined
    })
  })
})
