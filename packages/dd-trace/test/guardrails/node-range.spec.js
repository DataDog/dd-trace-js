'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  isNodeRangeSupported,
  parseNodeRange,
} = require('../../src/guardrails/node-range')

describe('guardrails/node-range', () => {
  describe('parseNodeRange', () => {
    it('parses a lower and upper major bound', () => {
      assert.deepStrictEqual(parseNodeRange('>=18 <27'), {
        minMajor: 18,
        maxMajor: 27,
      })
    })

    it('parses a lower-bound-only range', () => {
      assert.deepStrictEqual(parseNodeRange('>=22'), {
        minMajor: 22,
        maxMajor: undefined,
      })
    })

    it('throws for unsupported range shapes', () => {
      assert.throws(() => parseNodeRange('^22'), {
        message: 'Unsupported engines.node range: ^22',
      })
    })
  })

  describe('isNodeRangeSupported', () => {
    it('checks the lower bound inclusively', () => {
      assert.strictEqual(isNodeRangeSupported(17, '>=18 <27'), false)
      assert.strictEqual(isNodeRangeSupported(18, '>=18 <27'), true)
    })

    it('checks the upper bound exclusively when present', () => {
      assert.strictEqual(isNodeRangeSupported(26, '>=18 <27'), true)
      assert.strictEqual(isNodeRangeSupported(27, '>=18 <27'), false)
    })

    it('allows future majors when no upper bound is present', () => {
      assert.strictEqual(isNodeRangeSupported(27, '>=22'), true)
    })
  })
})
