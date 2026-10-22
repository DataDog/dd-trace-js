'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { LAMBDA_INTEGRATION_NAMES, listDisablesLambda } = require('../../src/lambda/integration-names')

describe('lambda integration names', () => {
  it('accepts both spellings of the integration', () => {
    assert.deepStrictEqual([...LAMBDA_INTEGRATION_NAMES].sort(), ['aws-lambda', 'lambda'])
  })

  it('matches either spelling anywhere in the list, ignoring surrounding space', () => {
    for (const value of [
      'lambda',
      'aws-lambda',
      'http,lambda,fs',
      'http, aws-lambda',
      ' lambda ',
      'fs,\tlambda',
    ]) {
      assert.strictEqual(listDisablesLambda(value), true, value)
    }
  })

  it('does not match other integrations or substrings', () => {
    for (const value of [
      undefined,
      '',
      'http,express',
      // Substring and superstring names must not match: `aws-sdk` is a different integration, and
      // `lambda-something` is not this one.
      'aws-sdk',
      'lambda-something',
      'not-lambda',
      'aws-lambda-extra',
    ]) {
      assert.strictEqual(listDisablesLambda(value), false, String(value))
    }
  })
})
