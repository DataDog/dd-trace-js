const { encodeValue, extractPrimaryKeys, calculateHashWithKnownKeys, calculatePutItemHash } = require('../../src/util/dynamodb')
const { generatePointerHash } = require('../../../dd-trace/src/util')

describe('encodeValue', () => {
  describe('basic type handling', () => {
    it('handles string (S) type correctly', () => {
      const result = encodeValue({ S: 'hello world' })
      expect(Buffer.isBuffer(result)).to.be.true
      expect(result).to.deep.equal(Buffer.from('hello world'))
    })

    it('handles number (N) type correctly', () => {
      const result = encodeValue({ N: '123.45' })
      expect(Buffer.isBuffer(result)).to.be.true
      expect(result).to.deep.equal(Buffer.from('123.45'))
    })

    it('handles binary (B) type correctly', () => {
      const binaryData = Buffer.from([1, 2, 3])
      const result = encodeValue({ B: binaryData })
      expect(Buffer.isBuffer(result)).to.be.true
      expect(result).to.deep.equal(binaryData)
    })
  })

  describe('edge cases', () => {
    it('returns empty buffer for null input', () => {
      const result = encodeValue(null)
      expect(Buffer.isBuffer(result)).to.be.true
      expect(result.length).to.equal(0)
    })

    it('returns empty buffer for undefined input', () => {
      const result = encodeValue(undefined)
      expect(Buffer.isBuffer(result)).to.be.true
      expect(result.length).to.equal(0)
    })

    it('returns empty buffer for unsupported type', () => {
      const result = encodeValue({ A: 'abc' })
      expect(Buffer.isBuffer(result)).to.be.true
      expect(result.length).to.equal(0)
    })

    it('returns empty buffer for malformed input', () => {
      const result = encodeValue({})
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
    it('handles missing values', () => {
      const keySet = new Set(['userId', 'timestamp'])
      const item = { userId: { S: 'user123' } } // timestamp missing
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.deep.equal(['timestamp', Buffer.from(''), 'userId', Buffer.from('user123')])
    })

    it('handles invalid value types', () => {
      const keySet = new Set(['userId', 'timestamp'])
      const item = {
        userId: { S: 'user123' },
        timestamp: { INVALID: '1234567' }
      }
      const result = extractPrimaryKeys(keySet, item)
      expect(result).to.deep.equal(['timestamp', Buffer.from(''), 'userId', Buffer.from('user123')])
    })
  })
})

describe('calculatePutItemHash', () => {
  it('generates correct hash for single string key', () => {
    const tableName = 'UserTable'
    const item = { userId: { S: 'user123' }, name: { S: 'John' } }
    const keyConfig = { UserTable: new Set(['userId']) }

    const actualHash = calculatePutItemHash(tableName, item, keyConfig)
    const expectedHash = generatePointerHash([tableName, 'userId', 'user123', '', ''])
    expect(actualHash).to.equal(expectedHash)
  })

  it('generates correct hash for single number key', () => {
    const tableName = 'OrderTable'
    const item = { orderId: { N: '98765' }, total: { N: '50.00' } }
    const keyConfig = { OrderTable: new Set(['orderId']) }

    const actualHash = calculatePutItemHash(tableName, item, keyConfig)
    const expectedHash = generatePointerHash([tableName, 'orderId', '98765', '', ''])
    expect(actualHash).to.equal(expectedHash)
  })

  it('generates correct hash for single binary key', () => {
    const tableName = 'BinaryTable'
    const binaryData = Buffer.from([1, 2, 3])
    const item = { binaryId: { B: binaryData }, data: { S: 'test' } }
    const keyConfig = { BinaryTable: new Set(['binaryId']) }

    const actualHash = calculatePutItemHash(tableName, item, keyConfig)
    const expectedHash = generatePointerHash([tableName, 'binaryId', binaryData, '', ''])
    expect(actualHash).to.equal(expectedHash)
  })

  it('generates correct hash for string-string key', () => {
    const tableName = 'UserEmailTable'
    const item = {
      userId: { S: 'user123' },
      email: { S: 'test@example.com' },
      verified: { BOOL: true }
    }
    const keyConfig = { UserEmailTable: new Set(['userId', 'email']) }

    const actualHash = calculatePutItemHash(tableName, item, keyConfig)
    const expectedHash = generatePointerHash([tableName, 'email', 'test@example.com', 'userId', 'user123'])
    expect(actualHash).to.equal(expectedHash)
  })

  it('generates correct hash for string-number key', () => {
    const tableName = 'UserActivityTable'
    const item = {
      userId: { S: 'user123' },
      timestamp: { N: '1234567' },
      action: { S: 'login' }
    }
    const keyConfig = { UserActivityTable: new Set(['userId', 'timestamp']) }

    const actualHash = calculatePutItemHash(tableName, item, keyConfig)
    const expectedHash = generatePointerHash([tableName, 'timestamp', '1234567', 'userId', 'user123'])
    expect(actualHash).to.equal(expectedHash)
  })

  it('generates correct hash for binary-binary key', () => {
    const tableName = 'BinaryTable'
    const binary1 = Buffer.from('abc')
    const binary2 = Buffer.from('1ef230')
    const item = {
      key1: { B: binary1 },
      key2: { B: binary2 },
      data: { S: 'test' }
    }
    const keyConfig = { BinaryTable: new Set(['key1', 'key2']) }

    const actualHash = calculatePutItemHash(tableName, item, keyConfig)
    const expectedHash = generatePointerHash([tableName, 'key1', binary1, 'key2', binary2])
    expect(actualHash).to.equal(expectedHash)
  })

  it('generates unique hashes for different tables', () => {
    const item = { userId: { S: 'user123' } }
    const keyConfig = {
      Table1: new Set(['userId']),
      Table2: new Set(['userId'])
    }

    const hash1 = calculatePutItemHash('Table1', item, keyConfig)
    const hash2 = calculatePutItemHash('Table2', item, keyConfig)
    expect(hash1).to.not.equal(hash2)
  })

  describe('edge cases', () => {
    it('returns undefined for unknown table', () => {
      const tableName = 'UnknownTable'
      const item = { userId: { S: 'user123' } }
      const keyConfig = { KnownTable: new Set(['userId']) }

      const result = calculatePutItemHash(tableName, item, keyConfig)
      expect(result).to.be.undefined
    })

    it('returns undefined for empty primary key config', () => {
      const tableName = 'UserTable'
      const item = { userId: { S: 'user123' } }

      const result = calculatePutItemHash(tableName, item, {})
      expect(result).to.be.undefined
    })

    it('returns undefined for invalid primary key config', () => {
      const tableName = 'UserTable'
      const item = { userId: { S: 'user123' } }
      const invalidConfig = { UserTable: ['userId'] } // Array instead of Set

      const result = calculatePutItemHash(tableName, item, invalidConfig)
      expect(result).to.be.undefined
    })

    it('handles missing attributes in item', () => {
      const tableName = 'UserTable'
      const item = { someOtherField: { S: 'value' } }
      const keyConfig = { UserTable: new Set(['userId']) }

      const actualHash = calculatePutItemHash(tableName, item, keyConfig)
      const expectedHash = generatePointerHash([tableName, 'userId', Buffer.from(''), '', ''])
      expect(actualHash).to.equal(expectedHash)
    })
  })
})

describe('calculateHashWithKnownKeys', () => {
  it('generates correct hash for single string key', () => {
    const tableName = 'UserTable'
    const keys = { userId: { S: 'user123' } }
    const actualHash = calculateHashWithKnownKeys(tableName, keys)
    const expectedHash = generatePointerHash([tableName, 'userId', 'user123', '', ''])
    expect(actualHash).to.equal(expectedHash)
  })

  it('generates correct hash for single number key', () => {
    const tableName = 'OrderTable'
    const keys = { orderId: { N: '98765' } }
    const actualHash = calculateHashWithKnownKeys(tableName, keys)
    const expectedHash = generatePointerHash([tableName, 'orderId', '98765', '', ''])
    expect(actualHash).to.equal(expectedHash)
  })

  it('generates correct hash for single binary key', () => {
    const tableName = 'BinaryTable'
    const binaryData = Buffer.from([1, 2, 3])
    const keys = { binaryId: { B: binaryData } }
    const actualHash = calculateHashWithKnownKeys(tableName, keys)
    const expectedHash = generatePointerHash([tableName, 'binaryId', binaryData, '', ''])
    expect(actualHash).to.equal(expectedHash)
  })

  it('generates correct hash for string-string key', () => {
    const tableName = 'UserEmailTable'
    const keys = {
      userId: { S: 'user123' },
      email: { S: 'test@example.com' }
    }
    const actualHash = calculateHashWithKnownKeys(tableName, keys)
    const expectedHash = generatePointerHash([tableName, 'email', 'test@example.com', 'userId', 'user123'])
    expect(actualHash).to.equal(expectedHash)
  })

  it('generates correct hash for string-number key', () => {
    const tableName = 'UserActivityTable'
    const keys = {
      userId: { S: 'user123' },
      timestamp: { N: '1234567' }
    }
    const actualHash = calculateHashWithKnownKeys(tableName, keys)
    const expectedHash = generatePointerHash([tableName, 'timestamp', '1234567', 'userId', 'user123'])
    expect(actualHash).to.equal(expectedHash)
  })

  it('generates correct hash for binary-binary key', () => {
    const tableName = 'BinaryTable'
    const binary1 = Buffer.from('abc')
    const binary2 = Buffer.from('1ef230')
    const keys = {
      key1: { B: binary1 },
      key2: { B: binary2 }
    }
    const actualHash = calculateHashWithKnownKeys(tableName, keys)
    const expectedHash = generatePointerHash([tableName, 'key1', binary1, 'key2', binary2])
    expect(actualHash).to.equal(expectedHash)
  })

  it('generates unique hashes', () => {
    const keys = { userId: { S: 'user123' } }
    const hash1 = calculateHashWithKnownKeys('Table1', keys)
    const hash2 = calculateHashWithKnownKeys('Table2', keys)
    expect(hash1).to.not.equal(hash2)
  })

  describe('edge cases', () => {
    it('handles empty keys object', () => {
      const tableName = 'UserTable'
      const hash = calculateHashWithKnownKeys(tableName, {})
      expect(hash).to.be.a('string')
    })

    it('handles invalid key types', () => {
      const tableName = 'UserTable'
      const keys = { userId: { INVALID: 'user123' } }
      const hash = calculateHashWithKnownKeys(tableName, keys)
      expect(hash).to.be.a('string')
    })
  })
})
