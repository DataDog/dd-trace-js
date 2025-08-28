'use strict'

const { generatePointerHash, encodeValue, extractPrimaryKeys, extractQueueMetadata } = require('../src/util')

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

describe('extractQueueMetadata', () => {
  describe('standard AWS SQS URLs', () => {
    it('handles standard AWS SQS URL', () => {
      const result = extractQueueMetadata('https://sqs.eu-west-1.amazonaws.com/987654321098/test-queue')
      expect(result).to.deep.equal({
        queueName: 'test-queue',
        arn: 'arn:aws:sqs:eu-west-1:987654321098:test-queue'
      })
    })

    it('handles AWS China region', () => {
      const result = extractQueueMetadata('https://sqs.cn-north-1.amazonaws.com.cn/123456789012/china-queue')
      expect(result).to.deep.equal({
        queueName: 'china-queue',
        arn: 'arn:aws-cn:sqs:cn-north-1:123456789012:china-queue'
      })
    })

    it('handles AWS GovCloud region', () => {
      const result = extractQueueMetadata('https://sqs.us-gov-west-1.amazonaws.com/123456789012/gov-queue')
      expect(result).to.deep.equal({
        queueName: 'gov-queue',
        arn: 'arn:aws-us-gov:sqs:us-gov-west-1:123456789012:gov-queue'
      })
    })

    it('handles queue name with special characters', () => {
      const result = extractQueueMetadata('https://sqs.us-west-2.amazonaws.com/123456789012/my-queue-test_123')
      expect(result).to.deep.equal({
        queueName: 'my-queue-test_123',
        arn: 'arn:aws:sqs:us-west-2:123456789012:my-queue-test_123'
      })
    })
  })

  describe('LocalStack URLs', () => {
    it('handles LocalStack URL with default port', () => {
      const result = extractQueueMetadata('http://localhost:4566/000000000000/local-queue')
      expect(result).to.deep.equal({
        queueName: 'local-queue',
        arn: 'arn:aws:sqs:us-east-1:000000000000:local-queue'
      })
    })

    it('handles LocalStack URL with custom port', () => {
      const result = extractQueueMetadata('http://127.0.0.1:9324/123456789012/dev-queue')
      expect(result).to.deep.equal({
        queueName: 'dev-queue',
        arn: 'arn:aws:sqs:us-east-1:123456789012:dev-queue'
      })
    })
  })

  describe('legacy AWS SQS URLs', () => {
    it('handles regional legacy format', () => {
      const result = extractQueueMetadata('https://us-west-2.queue.amazonaws.com/123456789012/legacy-queue')
      expect(result).to.deep.equal({
        queueName: 'legacy-queue',
        arn: 'arn:aws:sqs:us-west-2:123456789012:legacy-queue'
      })
    })

    it('handles global legacy format', () => {
      const result = extractQueueMetadata('https://queue.amazonaws.com/123456789012/global-legacy-queue')
      expect(result).to.deep.equal({
        queueName: 'global-legacy-queue',
        arn: 'arn:aws:sqs:us-east-1:123456789012:global-legacy-queue'
      })
    })

    it('handles legacy format without scheme', () => {
      const result = extractQueueMetadata('eu-central-1.queue.amazonaws.com/987654321098/no-scheme-legacy')
      expect(result).to.deep.equal({
        queueName: 'no-scheme-legacy',
        arn: 'arn:aws:sqs:eu-central-1:987654321098:no-scheme-legacy'
      })
    })
  })

  describe('URLs without schemes', () => {
    it('handles modern format without scheme', () => {
      const result = extractQueueMetadata('sqs.eu-west-1.amazonaws.com/123456789012/no-scheme-queue')
      expect(result).to.deep.equal({
        queueName: 'no-scheme-queue',
        arn: 'arn:aws:sqs:eu-west-1:123456789012:no-scheme-queue'
      })
    })

    it('handles localstack without scheme', () => {
      const result = extractQueueMetadata('localhost:4566/000000000000/local-no-scheme')
      expect(result).to.deep.equal({
        queueName: 'local-no-scheme',
        arn: 'arn:aws:sqs:us-east-1:000000000000:local-no-scheme'
      })
    })
  })

  describe('edge cases', () => {
    it('returns null for invalid URL with insufficient parts', () => {
      const result = extractQueueMetadata('https://sqs.us-east-1.amazonaws.com/incomplete')
      expect(result).to.be.null
    })

    it('returns null for completely malformed URL', () => {
      const result = extractQueueMetadata('not-a-valid-url')
      expect(result).to.be.null
    })

    it('returns null for empty string', () => {
      const result = extractQueueMetadata('')
      expect(result).to.be.null
    })

    it('returns null for null input', () => {
      const result = extractQueueMetadata(null)
      expect(result).to.be.null
    })

    it('returns null for undefined input', () => {
      const result = extractQueueMetadata(undefined)
      expect(result).to.be.null
    })

    it('handles URL with trailing slash', () => {
      const result = extractQueueMetadata('https://sqs.us-west-2.amazonaws.com/123456789012/my-queue/')
      expect(result).to.deep.equal({
        queueName: 'my-queue',
        arn: 'arn:aws:sqs:us-west-2:123456789012:my-queue'
      })
    })
  })
})
