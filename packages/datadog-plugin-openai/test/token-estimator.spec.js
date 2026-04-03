'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { estimateTokens } = require('../src/token-estimator')

describe('Plugin', () => {
  describe('openai token estimation', () => {
    function testEstimation (input, expected) {
      const tokens = estimateTokens(input)
      assert.strictEqual(tokens, expected)
    }

    it('should compute the number of tokens in a string', () => {
      testEstimation('hello world', 2)
    })

    it('should not throw for an empty string', () => {
      testEstimation('', 0)
    })

    it('should compute the number of tokens in an array of integer inputs', () => {
      testEstimation([1, 2, 3], 3)
    })

    it('should compute no tokens for invalid content', () => {
      testEstimation({}, 0)
    })
  })
})
