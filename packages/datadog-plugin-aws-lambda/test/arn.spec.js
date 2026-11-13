'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { parseLambdaARN, parseTagsFromARN } = require('../src/arn')

describe('arn utils', () => {
  it('parses arn properties', () => {
    assert.deepStrictEqual(parseLambdaARN('arn:aws:lambda:us-east-1:123497598159:function:my-test-lambda'), {
      account_id: '123497598159',
      functionname: 'my-test-lambda',
      region: 'us-east-1',
      resource: 'my-test-lambda',
    })
  })
  it('parses arn properties with version alias', () => {
    const arn = 'arn:aws:lambda:us-east-1:123497598159:function:my-test-lambda:my-version-alias'
    assert.deepStrictEqual(parseLambdaARN(arn, '1'), {
      account_id: '123497598159',
      functionname: 'my-test-lambda',
      region: 'us-east-1',
      executedversion: '1',
      resource: 'my-test-lambda:my-version-alias',
    })
  })
  it('parses arn properties with $latest version', () => {
    assert.deepStrictEqual(parseLambdaARN('arn:aws:lambda:us-east-1:123497598159:function:my-test-lambda:$Latest'), {
      account_id: '123497598159',
      functionname: 'my-test-lambda',
      region: 'us-east-1',
      resource: 'my-test-lambda:Latest',
    })
  })
  it('parses arn tags', () => {
    const parsedTags = parseTagsFromARN('arn:aws:lambda:us-east-1:123497598159:function:my-test-lambda')
    for (const tag of ['account_id:123497598159', 'functionname:my-test-lambda', 'region:us-east-1']) {
      assert(parsedTags.includes(tag))
    }
  })
  it('parses arn tags with version', () => {
    const parsedTags = parseTagsFromARN('arn:aws:lambda:us-east-1:123497598159:function:my-test-lambda:1')
    for (const tag of [
      'account_id:123497598159',
      'functionname:my-test-lambda',
      'region:us-east-1',
      'resource:my-test-lambda:1',
    ]) {
      assert(parsedTags.includes(tag))
    }
  })
})

describe('ARN compatibility boundaries', () => {
  const arn = 'arn:aws:lambda:us-east-1:123:function:MixedCase'

  for (const [qualifier, expected] of [
    ['1', { resource: 'MixedCase:1' }],
    ['$LATEST', { resource: 'MixedCase:LATEST' }],
    ['alias', { executedversion: '42', resource: 'MixedCase:alias' }],
    ['0', { executedversion: '42', resource: 'MixedCase:0' }],
    ['', { executedversion: '42', resource: 'MixedCase:' }],
    ['01', { resource: 'MixedCase:01' }],
  ]) {
    it(`preserves version/alias parsing for qualifier ${JSON.stringify(qualifier)}`, () => {
      assert.deepStrictEqual(parseLambdaARN(`${arn}:${qualifier}`, '42'), {
        region: 'us-east-1', account_id: '123', functionname: 'MixedCase', ...expected,
      })
    })
  }

  it('retains an undefined executed version for an alias and tag-string order', () => {
    assert.deepStrictEqual(parseTagsFromARN(`${arn}:alias`), [
      'region:us-east-1', 'account_id:123', 'functionname:MixedCase',
      'executedversion:undefined', 'resource:MixedCase:alias',
    ])
  })

  it('uses ARN fields verbatim across partitions and ignores trailing fields', () => {
    for (const partition of ['aws', 'aws-cn', 'aws-us-gov']) {
      assert.deepStrictEqual(parseLambdaARN(`arn:${partition}:lambda:region:123:function:Name:1:ignored`), {
        region: 'region', account_id: '123', functionname: 'Name', resource: 'Name:1',
      })
    }
  })

  it('preserves undefined fields for malformed strings without changing the environment', () => {
    const env = { ...process.env }
    assert.deepStrictEqual(parseLambdaARN('invalid'), {
      region: undefined, account_id: undefined, functionname: undefined, resource: undefined,
    })
    assert.deepStrictEqual(parseTagsFromARN(''), [
      'region:undefined', 'account_id:undefined', 'functionname:undefined', 'resource:undefined',
    ])
    assert.deepStrictEqual({ ...process.env }, env)
  })
})
