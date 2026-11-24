'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { DYNAMODB_PTR_KIND, S3_PTR_KIND, SPAN_POINTER_DIRECTION } = require('../../dd-trace/src/constants')
const DynamoDb = require('../../datadog-plugin-aws-sdk/src/services/dynamodb')
const S3 = require('../../datadog-plugin-aws-sdk/src/services/s3')
const aws = require('../../datadog-plugin-aws-sdk/src/util')
const { getSpanPointerAttributes } = require('../src/span-pointers')
const { eventTypes } = require('../src/trigger')

const table = 'mockTableName'
const arn = `arn:aws:dynamodb:us-east-1:123467890:table/${table}/stream/2024-11-19T16:00:00.000`

function s3Record (
  bucket = 'test-bucket', key = 'test-key', eTag = 'test-etag', eventName = 'ObjectCreated:SomeEventName'
) {
  return { s3: { bucket: { name: bucket }, object: { key, eTag } }, eventName }
}

function dynamoRecord (keys, eventName = 'INSERT', eventSourceARN = arn) {
  return { dynamodb: { Keys: keys }, eventName, eventSourceARN }
}

function pointer (kind, hash = 'mock-hash-123') {
  return { kind, direction: SPAN_POINTER_DIRECTION.UPSTREAM, hash }
}

// The thirteen source span-pointers.spec.ts cases retain their inputs, outputs and hash-argument assertions.
describe('Lambda span pointer source cases', () => {
  beforeEach(() => { sinon.stub(aws, 'generatePointerHash').returns('mock-hash-123') })
  afterEach(() => { sinon.restore() })

  it('returns undefined when eventSource is undefined', () => {
    assert.strictEqual(getSpanPointerAttributes(undefined, {}), undefined)
  })

  it('returns undefined for unsupported event types', () => {
    assert.strictEqual(getSpanPointerAttributes('unsupported', {}), undefined)
  })

  describe('S3 event processing', () => {
    it('processes single S3 record correctly', () => {
      assert.deepStrictEqual(getSpanPointerAttributes(eventTypes.s3, { Records: [s3Record()] }), [pointer(S3_PTR_KIND)])
      sinon.assert.calledWith(aws.generatePointerHash, ['test-bucket', 'test-key', 'test-etag'])
    })

    it('processes multiple S3 records correctly', () => {
      const event = { Records: [s3Record('bucket1', 'key1', 'etag1'), s3Record('bucket2', 'key2', 'etag2')] }
      assert.deepStrictEqual(getSpanPointerAttributes(eventTypes.s3, event), [
        pointer(S3_PTR_KIND), pointer(S3_PTR_KIND),
      ])
    })

    it('handles empty Records array', () => {
      assert.deepStrictEqual(getSpanPointerAttributes(eventTypes.s3, { Records: [] }), [])
    })

    it('handles missing Records property', () => {
      assert.deepStrictEqual(getSpanPointerAttributes(eventTypes.s3, {}), [])
    })

    it('skips invalid records but processes valid ones', () => {
      const event = { Records: [{}, s3Record('valid-bucket', 'valid-key', 'valid-etag')] }
      assert.deepStrictEqual(getSpanPointerAttributes(eventTypes.s3, event), [pointer(S3_PTR_KIND)])
    })
  })

  describe('DynamoDB event processing', () => {
    it('processes Dynamo record with one primary key correctly', () => {
      const event = { Records: [dynamoRecord({ someKey1: { S: 'mockPrimaryValue1' } })] }
      assert.deepStrictEqual(getSpanPointerAttributes(eventTypes.dynamoDB, event), [pointer(DYNAMODB_PTR_KIND)])
      sinon.assert.calledWith(aws.generatePointerHash, [table, 'someKey1', Buffer.from('mockPrimaryValue1'), '', ''])
    })

    it('processes Dynamo record with two primary keys correctly', () => {
      const event = {
        Records: [dynamoRecord({
          someKey1: { S: 'mockPrimaryValue1' }, someKey2: { S: 'mockPrimaryValue2' },
        }, 'MODIFY')],
      }
      assert.deepStrictEqual(getSpanPointerAttributes(eventTypes.dynamoDB, event), [pointer(DYNAMODB_PTR_KIND)])
      sinon.assert.calledWith(aws.generatePointerHash, [
        table, 'someKey1', Buffer.from('mockPrimaryValue1'), 'someKey2', Buffer.from('mockPrimaryValue2'),
      ])
    })

    it('processes multiple DynamoDB records correctly', () => {
      const event = {
        Records: [
          dynamoRecord({ someKey1: { S: 'mockPrimaryValue1' } }, 'MODIFY'),
          dynamoRecord({ someKey2: { S: 'mockPrimaryValue2' } }, 'REMOVE'),
        ],
      }
      assert.deepStrictEqual(getSpanPointerAttributes(eventTypes.dynamoDB, event), [
        pointer(DYNAMODB_PTR_KIND), pointer(DYNAMODB_PTR_KIND),
      ])
      sinon.assert.calledWith(aws.generatePointerHash, [table, 'someKey1', Buffer.from('mockPrimaryValue1'), '', ''])
      sinon.assert.calledWith(aws.generatePointerHash, [table, 'someKey2', Buffer.from('mockPrimaryValue2'), '', ''])
    })

    it('handles empty Records array', () => {
      assert.deepStrictEqual(getSpanPointerAttributes(eventTypes.dynamoDB, { Records: [] }), [])
    })

    it('handles missing Records property', () => {
      assert.deepStrictEqual(getSpanPointerAttributes(eventTypes.dynamoDB, {}), [])
    })

    it('skips invalid records but processes valid ones', () => {
      const event = { Records: [{}, dynamoRecord({ someKey1: { S: 'mockPrimaryValue1' } }, 'MODIFY')] }
      assert.deepStrictEqual(getSpanPointerAttributes(eventTypes.dynamoDB, event), [pointer(DYNAMODB_PTR_KIND)])
      sinon.assert.calledWith(aws.generatePointerHash, [table, 'someKey1', Buffer.from('mockPrimaryValue1'), '', ''])
    })
  })
})

describe('Lambda span pointer boundaries and shared producer hashing', () => {
  for (const eventName of ['ObjectCreated', 'ObjectCreated:Put', 'ObjectCreated:Copy',
    'ObjectCreated:CompleteMultipartUpload', 'ObjectCreatedSuffix']) {
    it(`retains the source S3 prefix filter for ${eventName}`, () => {
      const event = { Records: [s3Record('b', 'k', 'e', eventName)] }
      assert.strictEqual(getSpanPointerAttributes(eventTypes.s3, event).length, 1)
    })
  }

  for (const eventName of [undefined, '', 'ObjectRemoved:Delete', 'ObjectRestore:Completed', 'objectCreated:Put']) {
    it(`does not create an S3 pointer for ${eventName}`, () => {
      const record = s3Record(); record.eventName = eventName
      assert.deepStrictEqual(getSpanPointerAttributes(eventTypes.s3, { Records: [record] }), [])
    })
  }

  for (const field of ['bucket', 'key', 'eTag']) {
    it(`skips an S3 record missing ${field} without dropping its valid sibling`, () => {
      const record = s3Record()
      if (field === 'bucket') delete record.s3.bucket.name
      else delete record.s3.object[field]
      assert.strictEqual(getSpanPointerAttributes(eventTypes.s3, { Records: [record, s3Record()] }).length, 1)
    })
  }

  for (const eTag of ['etag', '"etag"', '"etag', 'etag"', '""', 'multi-part-5']) {
    for (const [operation, placement] of [
      ['putObject', 'ETag'], ['copyObject', 'CopyObjectResult'],
      ['completeMultipartUpload', 'data'], ['copyObject', 'data.CopyObjectResult'],
    ]) {
      it(`matches actual S3 producer output for ${operation} ${placement} ${JSON.stringify(eTag)}`, () => {
        const producer = new S3({}, {})
        const span = { addSpanPointer: sinon.spy() }
        const response = { request: { operation, params: { Bucket: 'bucket', Key: 'raw+key%20你好' } } }
        if (placement === 'ETag') response.ETag = eTag
        else if (placement === 'CopyObjectResult') response.CopyObjectResult = { ETag: eTag }
        else if (placement === 'data') response.data = { ETag: eTag }
        else response.data = { CopyObjectResult: { ETag: eTag } }
        producer.addSpanPointers(span, response)
        const [consumer] = getSpanPointerAttributes(eventTypes.s3, {
          Records: [s3Record('bucket', 'raw+key%20你好', eTag)],
        })
        sinon.assert.calledOnceWithExactly(span.addSpanPointer,
          consumer.kind, SPAN_POINTER_DIRECTION.DOWNSTREAM, consumer.hash)
        assert.strictEqual(consumer.direction, SPAN_POINTER_DIRECTION.UPSTREAM)
        const expectedETag = eTag.startsWith('"') && eTag.endsWith('"') ? eTag.slice(1, -1) : eTag
        assert.strictEqual(consumer.hash, aws.generatePointerHash(['bucket', 'raw+key%20你好', expectedETag]))
      })
    }
  }

  for (const eventName of ['INSERT', 'MODIFY', 'REMOVE']) {
    for (const keys of [
      { id: { S: 'hello|world' } },
      { id: { N: '123.450' } },
      { id: { B: Buffer.from([0, 1, 255]) } },
      { id: { B: 'AQID' } },
      { z: { N: '42' }, a: { S: '你好' } },
      { a: { S: '你好' }, z: { N: '42' } },
    ]) {
      it(`matches actual DynamoDB producer output for ${eventName} ${JSON.stringify(keys)}`, () => {
        const before = Object.keys(keys)
        const producer = new DynamoDb({}, { DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS: JSON.stringify({ [table]: before }) })
        const span = { addSpanPointer: sinon.spy() }
        const operation = eventName === 'INSERT' ? 'putItem' : eventName === 'MODIFY' ? 'updateItem' : 'deleteItem'
        producer.addSpanPointers(span, { request: { operation, params: { TableName: table, Item: keys, Key: keys } } })
        const [consumer] = getSpanPointerAttributes(eventTypes.dynamoDB, { Records: [dynamoRecord(keys, eventName)] })
        sinon.assert.calledOnceWithExactly(span.addSpanPointer,
          consumer.kind, SPAN_POINTER_DIRECTION.DOWNSTREAM, consumer.hash)
        assert.strictEqual(consumer.direction, SPAN_POINTER_DIRECTION.UPSTREAM)
        assert.deepStrictEqual(Object.keys(keys), before)
      })
    }
  }

  for (const [name, record] of [
    ['unsupported event name', dynamoRecord({ id: { S: 'value' } }, 'UPDATE')],
    ['missing table', dynamoRecord({ id: { S: 'value' } }, 'INSERT', 'arn-without-table')],
    ['empty table', dynamoRecord({ id: { S: 'value' } }, 'INSERT', 'table//stream/id')],
    ['missing keys', dynamoRecord(undefined)],
    ['empty keys', dynamoRecord({})],
    ['unsupported key type', dynamoRecord({ id: { BOOL: true } })],
  ]) {
    it(`skips DynamoDB ${name} without dropping its valid sibling`, () => {
      const event = { Records: [record, dynamoRecord({ id: { S: 'valid' } })] }
      assert.strictEqual(getSpanPointerAttributes(eventTypes.dynamoDB, event).length, 1)
    })
  }

  it('retains source table-name matching and shared first-two-key behavior', () => {
    const keys = { z: { S: 'last' }, b: { S: 'second' }, a: { S: 'first' } }
    const [consumer] = getSpanPointerAttributes(eventTypes.dynamoDB, {
      Records: [dynamoRecord(keys, 'INSERT', 'prefix/table/name/suffix')],
    })
    assert.strictEqual(consumer.hash, DynamoDb.calculateHashWithKnownKeys('name', keys))
  })
})
