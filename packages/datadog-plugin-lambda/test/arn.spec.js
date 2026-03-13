'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
const { parseLambdaARN, parseTagsFromARN } = require('../src/arn')

describe('arn', () => {
  describe('parseLambdaARN', () => {
    it('parses a basic function ARN without alias', () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:function:my-function'
      const result = parseLambdaARN(arn)
      assert.deepEqual(result, {
        region: 'us-east-1',
        account_id: '123456789012',
        functionname: 'my-function',
        resource: 'my-function',
      })
    })

    it('parses an ARN with a named alias', () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:function:my-function:prod'
      const result = parseLambdaARN(arn, '42')
      assert.deepEqual(result, {
        region: 'us-east-1',
        account_id: '123456789012',
        functionname: 'my-function',
        resource: 'my-function:prod',
        executedversion: '42',
      })
    })

    it('parses an ARN with a $LATEST alias', () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:function:my-function:$LATEST'
      const result = parseLambdaARN(arn)
      assert.deepEqual(result, {
        region: 'us-east-1',
        account_id: '123456789012',
        functionname: 'my-function',
        resource: 'my-function:LATEST',
      })
    })

    it('parses an ARN with a numeric version alias', () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:function:my-function:42'
      const result = parseLambdaARN(arn, '42')
      assert.deepEqual(result, {
        region: 'us-east-1',
        account_id: '123456789012',
        functionname: 'my-function',
        resource: 'my-function:42',
      })
    })

    it('parses an ARN from a different region', () => {
      const arn = 'arn:aws:lambda:eu-west-1:987654321098:function:other-func'
      const result = parseLambdaARN(arn)
      assert.equal(result.region, 'eu-west-1')
      assert.equal(result.account_id, '987654321098')
      assert.equal(result.functionname, 'other-func')
    })
  })

  describe('parseTagsFromARN', () => {
    it('returns tags as key:value strings for basic ARN', () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:function:my-function'
      const tags = parseTagsFromARN(arn)
      assert.ok(tags.includes('region:us-east-1'))
      assert.ok(tags.includes('account_id:123456789012'))
      assert.ok(tags.includes('functionname:my-function'))
      assert.ok(tags.includes('resource:my-function'))
      assert.equal(tags.length, 4)
    })

    it('returns tags including executedversion for aliased ARN', () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:function:my-function:prod'
      const tags = parseTagsFromARN(arn, '7')
      assert.ok(tags.includes('executedversion:7'))
      assert.ok(tags.includes('resource:my-function:prod'))
      assert.equal(tags.length, 5)
    })

    it('returns tags for $LATEST alias without executedversion', () => {
      const arn = 'arn:aws:lambda:us-east-1:123456789012:function:my-function:$LATEST'
      const tags = parseTagsFromARN(arn)
      assert.ok(tags.includes('resource:my-function:LATEST'))
      assert.equal(tags.length, 4)
    })
  })
})
