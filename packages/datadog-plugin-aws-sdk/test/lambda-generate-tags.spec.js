'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const Lambda = require('../src/services/lambda')

describe('Lambda generateTags', () => {
  for (const functionArn of [
    'arn:aws:lambda:us-east-1:123456789012:function:checkout',
    'arn:aws:lambda:us-east-1:123456789012:function:checkout:live',
  ]) {
    it(`tags the function ARN of ${functionArn}`, () => {
      const tags = new Lambda({}, {}).generateTags({ FunctionName: functionArn }, 'invoke')

      assert.deepStrictEqual(tags, {
        'resource.name': `invoke ${functionArn}`,
        functionname: functionArn,
        'aws.lambda': functionArn,
        'aws.function.arn': functionArn,
      })
    })
  }

  for (const functionName of ['checkout', 'checkout:live', '123456789012:function:checkout']) {
    it(`does not tag a function ARN for ${functionName}`, () => {
      const tags = new Lambda({}, {}).generateTags({ FunctionName: functionName }, 'invoke')

      assert.deepStrictEqual(tags, {
        'resource.name': `invoke ${functionName}`,
        functionname: functionName,
        'aws.lambda': functionName,
      })
    })
  }
})
