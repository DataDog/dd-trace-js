'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const DynamoDb = require('../src/services/dynamodb')

describe('DynamoDB generateTags', () => {
  const tableArn = 'arn:aws:dynamodb:us-east-1:123456789012:table/orders'

  it('tags the table ARN when the request names the table by ARN', () => {
    const tags = new DynamoDb({}, {}).generateTags({ TableName: tableArn }, 'getItem')

    assert.deepStrictEqual(tags, {
      'resource.name': `getItem ${tableArn}`,
      'aws.dynamodb.table_name': tableArn,
      tablename: tableArn,
      'aws.table.arn': tableArn,
      'span.type': 'dynamodb',
      'db.system': 'aws.dynamodb',
    })
  })

  it('tags the table ARN of a single-table batch keyed by ARN', () => {
    const tags = new DynamoDb({}, {}).generateTags({ RequestItems: { [tableArn]: {} } }, 'batchGetItem')

    assert.strictEqual(tags['aws.table.arn'], tableArn)
  })

  it('tags the ARN of other partitions', () => {
    const govArn = 'arn:aws-us-gov:dynamodb:us-gov-west-1:123456789012:table/orders'
    const tags = new DynamoDb({}, {}).generateTags({ TableName: govArn }, 'getItem')

    assert.strictEqual(tags['aws.table.arn'], govArn)
  })

  for (const tableName of [
    'orders',
    'arn:aws:dynamodb:us-east-1:123456789012:table/orders/index/by-date',
    'arn:aws:dynamodb:us-east-1:123456789012:table/orders/stream/2026-01-01T00:00:00.000',
    'arn:aws:s3:::orders',
  ]) {
    it(`does not tag a table ARN for ${tableName}`, () => {
      const tags = new DynamoDb({}, {}).generateTags({ TableName: tableName }, 'getItem')

      assert.strictEqual(tags.tablename, tableName)
      assert.ok(!('aws.table.arn' in tags))
    })
  }
})
